import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConsigneDev, EtatChecks, ForgeGit, RefDepot, Resultat, SessionDev } from "@/lib/missions/chantiers/ports-moteur";
import { fauxPortsDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { PortsDev } from "@/lib/missions/chantiers/etapes";
import type { ForgeIntegration } from "@/lib/missions/equipe/integration";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE FORGE DE TEST ADOSSÉE À UN VRAI DÉPÔT GIT — RÉSERVÉE AUX TESTS (O2, décision 0059 § 9).
 *
 * Pas un dictionnaire qui fait semblant : un dépôt nu sur disque, de VRAIS commits (plomberie git), une VRAIE fusion
 * (`git merge-tree --write-tree` : conflit réel, ou arbre fusionné), une avance FAST-FORWARD en compare-et-échange
 * (`git update-ref <ref> <neuf> <ancien>` : refusée si la branche a bougé), et une « CI » qui EXÉCUTE le code du SHA
 * (arbre extrait, `node verif.mjs`) — un module qui appelle une fonction renommée échoue pour de vrai. Partagée entre
 * PROCESSUS (le dépôt est sur disque, git verrouille ses refs) : c'est elle que servent les bancs multi-processus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ok = <T>(valeur: T): Resultat<T> => ({ ok: true, valeur });

export interface ForgeGitLocale extends ForgeIntegration {
  racine: string;
  git(...args: string[]): string;
  /**
   * Écrit un commit sur `branche` (créée depuis `depuis` si absente) : `null` supprime un fichier. `fusionAvec` : un
   * commit de FUSION avec la tête de cette branche (ce que fait un travailleur qui « fusionne origin/<cible> »). Rend le SHA.
   */
  commit(branche: string, fichiers: Record<string, string | null>, message: string, depuis?: string, fusionAvec?: string): string;
  /** Le journal des écritures de refs (qui, quoi) — un banc y compte les avances de la cible. */
  journal(): { pid: number; geste: string; ref: string; sha: string }[];
}

export function forgeGitLocale(racine = fs.mkdtempSync(path.join(os.tmpdir(), "forge-git-"))): ForgeGitLocale {
  const depot = path.join(racine, "depot.git");
  const journalFichier = path.join(racine, "journal.jsonl");
  const ciDossier = path.join(racine, "ci");
  if (!fs.existsSync(depot)) {
    fs.mkdirSync(ciDossier, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", depot]);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "banc", GIT_AUTHOR_EMAIL: "banc@test", GIT_COMMITTER_NAME: "banc", GIT_COMMITTER_EMAIL: "banc@test", GIT_AUTHOR_DATE: "2026-11-02T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-02T10:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", ["--git-dir", depot, ...args], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const essayer = (...args: string[]) => spawnSync("git", ["--git-dir", depot, ...args], { env, encoding: "utf8" });
  const noter = (geste: string, ref: string, sha: string) => fs.appendFileSync(journalFichier, `${JSON.stringify({ pid: process.pid, geste, ref, sha })}\n`);
  const tete = (b: string): string | null => { const r = essayer("rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`); return r.status === 0 ? r.stdout.trim() : null; };

  const commit = (branche: string, fichiers: Record<string, string | null>, message: string, depuis?: string, fusionAvec?: string): string => {
    const parent = tete(branche) ?? (depuis ? tete(depuis) ?? depuis : null);
    const autre = fusionAvec ? tete(fusionAvec) : null;
    const index = path.join(racine, `index-${process.pid}-${Date.now()}`);
    const avecIndex = (...args: string[]) => execFileSync("git", ["--git-dir", depot, ...args], { env: { ...env, GIT_INDEX_FILE: index }, encoding: "utf8" }).trim();
    try {
      if (parent && autre) avecIndex("read-tree", git("merge-tree", "--write-tree", parent, autre).split("\n")[0]!.trim());
      else if (parent) avecIndex("read-tree", parent); else avecIndex("read-tree", "--empty");
      for (const [chemin, contenu] of Object.entries(fichiers)) {
        if (contenu === null) { avecIndex("update-index", "--force-remove", chemin); continue; }
        const blob = execFileSync("git", ["--git-dir", depot, "hash-object", "-w", "--stdin"], { env, input: contenu, encoding: "utf8" }).trim();
        avecIndex("update-index", "--add", "--cacheinfo", `100644,${blob},${chemin}`);
      }
      const arbre = avecIndex("write-tree");
      const sha = git("commit-tree", arbre, ...(parent ? ["-p", parent] : []), ...(autre ? ["-p", autre] : []), "-m", message);
      git("update-ref", `refs/heads/${branche}`, sha, ...(tete(branche) ? [tete(branche)!] : [""]));
      return sha;
    } finally {
      fs.rmSync(index, { force: true });
    }
  };

  /** LA CI : l'arbre du SHA extrait, `node verif.mjs` exécuté ; mise en cache par SHA (un fichier, lisible par tous les processus). */
  const ci = (sha: string): EtatChecks => {
    const cache = path.join(ciDossier, `${sha}.json`);
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8")) as EtatChecks;
    const dir = fs.mkdtempSync(path.join(racine, "arbre-"));
    try {
      const tar = execFileSync("git", ["--git-dir", depot, "archive", sha], { env });
      execFileSync("tar", ["-x", "-C", dir], { input: tar });
      if (!fs.existsSync(path.join(dir, "verif.mjs"))) return { statut: "aucun", echecs: [] };
      const r = spawnSync("node", ["verif.mjs"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
      const etat: EtatChecks = r.status === 0 ? { statut: "vert", echecs: [] } : { statut: "rouge", echecs: [{ nom: "verif", url: `ci://${sha}`, extrait: `${r.stderr}${r.stdout}`.slice(-2_000) }] };
      fs.writeFileSync(cache, JSON.stringify(etat));
      return etat;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const forge: ForgeGitLocale = {
    racine,
    git,
    commit,
    journal: () => (fs.existsSync(journalFichier) ? fs.readFileSync(journalFichier, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; geste: string; ref: string; sha: string }) : []),
    tete: async (_d: RefDepot, b: string) => ok(tete(b)),
    creerBranche: async (_d, b, sha) => {
      const r = essayer("update-ref", `refs/heads/${b}`, sha, "");
      if (r.status !== 0) return tete(b) === sha ? ok(true as const) : { ok: false, erreur: `branche ${b} déjà existante`, definitif: true };
      noter("creer", b, sha);
      return ok(true as const);
    },
    supprimerBranche: async (_d, b) => { essayer("update-ref", "-d", `refs/heads/${b}`); noter("supprimer", b, ""); return ok(true as const); },
    fusionnerDans: async (_d, base, branche, message) => {
      const a = tete(base);
      const b = tete(branche);
      if (!a || !b) return { ok: false, erreur: "branche introuvable", definitif: true };
      if (essayer("merge-base", "--is-ancestor", b, a).status === 0) return ok({ sha: a });
      const m = essayer("merge-tree", "--write-tree", a, b);
      if (m.status === 1) return ok({ conflit: true as const });
      if (m.status !== 0) return { ok: false, erreur: m.stderr.trim(), definitif: true };
      const sha = git("commit-tree", m.stdout.split("\n")[0]!.trim(), "-p", a, "-p", b, "-m", message);
      const u = essayer("update-ref", `refs/heads/${base}`, sha, a);
      if (u.status !== 0) return { ok: false, erreur: `${base} a bougé pendant la fusion`, reessayerApresMs: 1_000 };
      noter("fusionner", base, sha);
      return ok({ sha });
    },
    estAncetre: async (_d, a, sha) => ok(essayer("merge-base", "--is-ancestor", a, sha).status === 0),
    fichiersModifies: async (_d, base, t) => ok(git("diff", "--name-only", `${base}...${t}`).split("\n").filter(Boolean)),
    avancer: async (_d, b, sha) => {
      const actuel = tete(b);
      if (actuel && essayer("merge-base", "--is-ancestor", actuel, sha).status !== 0) return { ok: false, erreur: `non fast-forward : ${b} a bougé`, definitif: true };
      const u = essayer("update-ref", `refs/heads/${b}`, sha, actuel ?? "");
      if (u.status !== 0) return { ok: false, erreur: `non fast-forward : ${b} a bougé (compare-et-échange refusé)`, definitif: true };
      noter("avancer", b, sha);
      return ok(true as const);
    },
    checks: async (_d, sha) => ok(ci(sha)),
  };
  return forge;
}

/** La « CI » du dépôt de banc : chaque module se CHARGE (un import cassé échoue), et le fichier GÉNÉRÉ (la liste des modules) est à jour. */
const VERIF = `import fs from "node:fs";
const mods = fs.readdirSync("src/m").filter((f) => f.endsWith(".mjs")).sort();
for (const m of mods) await import("./src/m/" + m);
const attendu = JSON.stringify(mods, null, 1) + "\\n";
if (fs.readFileSync("src/lib/actions/contrat.genere.json", "utf8") !== attendu) { console.error("contrat.genere.json n'est pas à jour : régénérer"); process.exit(1); }
`;
/** Le fichier généré du dépôt de banc : la liste des modules (ce que `npm run actions:contrat` régénérerait). */
export const contrat = (modules: string[]) => `${JSON.stringify(modules, null, 1)}\n`;

/** Un dépôt de départ : `lib.mjs` exporte `f`, le fichier généré est à jour, la CI de `main` est verte. */
export function depotDeBanc(racine?: string): { forge: ForgeGitLocale; cible: string } {
  const forge = forgeGitLocale(racine);
  forge.commit("main", { "verif.mjs": VERIF, "src/m/lib.mjs": "export function f() { return 1; }\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs"]) }, "départ");
  return { forge, cible: "main" };
}

/**
 * LES PORTS DES CHANTIERS SUR LE VRAI DÉPÔT : les sessions factices COMMITENT dans git (`travail` : ce que la session n°
 * `n` de la branche fait — rien rendu = elle ne pousse rien), la forge lit branches, fichiers et CI dans git, la file
 * d'intégration y écrit. Les « sessions » parlent comme le relais : une relance va à la MÊME session.
 */
export function portsSurGit(forge: ForgeGitLocale, travail: (c: ConsigneDev & { probleme?: string }, n: number) => void): PortsDev & { messages: { session: string; texte: string }[] } {
  const base = fauxPortsDev();
  const sessions = new Map<string, number>();
  const messages: { session: string; texte: string }[] = [];
  const session = (c: ConsigneDev & { probleme?: string }): Resultat<SessionDev> => {
    const n = (sessions.get(c.branche) ?? 0) + 1;
    sessions.set(c.branche, n);
    travail(c, n);
    return ok({ sessionId: `session-${c.branche}`, url: `https://claude.ai/code/session-${c.branche}`, lanceeLe: new Date().toISOString(), moyen: "relais-cli" });
  };
  const forgeMoteur: ForgeGit = {
    ...base.forge,
    branche: async (_d, b, depuis) => {
      const t = forge.git("for-each-ref", "--format=%(objectname)", `refs/heads/${b}`) || null;
      if (!t) return ok({ existe: false, sha: null, commits: [], fichiers: [] });
      const fichiers = depuis ? forge.git("diff", "--name-only", `${depuis}...${t}`).split("\n").filter(Boolean) : [];
      return ok({ existe: true, sha: t, commits: [{ sha: t, message: "travail", le: new Date().toISOString() }], fichiers });
    },
    pr: async () => ok(null),
    ouvrirPr: async () => ({ ok: false, erreur: "ouvrir une PR : non pris en charge au banc", definitif: true }),
    checks: (d, sha) => forge.checks(d, sha),
  };
  return {
    ...base,
    messages,
    agent: {
      disponible: async () => ({ ok: true, moyens: ["relais-cli"] }),
      lancer: async (c) => session(c),
      relancer: async (c) => { if (c.session) messages.push({ session: c.session, texte: c.probleme }); return session(c); },
    },
    forge: forgeMoteur,
    integration: forge,
  };
}
