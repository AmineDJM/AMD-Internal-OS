import type * as C2 from "@/platform/dev/ports";
import { construireConsigne } from "@/platform/dev/consigne";
import { routineDuDepot, type Env } from "@/platform/dev/config";
import type { AgentDeveloppeur, DeploiementRender, ForgeGit, Hebergeur, RefDepot, Resultat } from "@/lib/missions/chantiers/ports-moteur";
import type { PortsDev } from "@/lib/missions/chantiers/etapes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONNECTEURS RÉELS (lot C2) DANS LES TERMES DU MOTEUR (lot C1, décision 0042) — une couche d'adaptation PURE.
 *
 * Elle reçoit les trois connecteurs (`platform/in-process/chantiers/connecteurs.ts`, composés par `scheduled.ts`) et
 * rend le contrat du moteur (`ports-moteur.ts`). Ce que le moteur demande et que les connecteurs n'ont pas est dit :
 *   • ouvrir une PR : Claude Code l'ouvre (sa consigne le dit) — refus « non pris en charge », le moteur continue ;
 *   • fusionner : la Direction fusionne à la main après la carte de validation — le moteur attend la fusion ;
 *   • la santé d'un service : un GET de son URL publique (`fetch` injecté, délai borné), rien d'autre.
 * Une erreur `INCERTAIN` (la requête a pu partir) remonte comme telle : jamais de relance à l'aveugle. Aucun secret
 * ne passe ici — les connecteurs les masquent avant de construire leurs messages.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const nom = (d: RefDepot): C2.NomDepot => `${d.proprietaire}/${d.nom}`;
const erreur = (e: C2.ErreurConnecteur): Extract<Resultat<never>, { ok: false }> => ({
  ok: false, erreur: e.message, ...(e.reessayerApresMs ? { reessayerApresMs: e.reessayerApresMs } : {}),
  definitif: !e.reessayable && e.code !== "INCERTAIN", ...(e.code === "INCERTAIN" ? { incertain: true } : {}),
});
const nonPrisEnCharge = (quoi: string): Extract<Resultat<never>, { ok: false }> => ({ ok: false, erreur: `${quoi} : non pris en charge par les connecteurs`, definitif: true });
const vers = <A, B>(r: C2.Resultat<A>, f: (a: A) => B): Resultat<B> => (r.ok ? { ok: true, valeur: f(r.valeur) } : erreur(r.erreur));

const deploiementDe = (d: C2.Deploiement): DeploiementRender => ({ id: d.id, statut: d.statut, commit: d.sha, le: d.creeLe ?? d.termineLe ?? new Date().toISOString() });

/** Le déploiement « en file » (202 sans corps) : retrouvé ensuite par son SHA dans la liste du service. */
const EN_FILE = "file:";

function forgeDe(f: C2.ForgeGit): ForgeGit {
  return {
    branche: async (d, b, base) => {
      const tete = await f.teteDeBranche(nom(d), b);
      if (!tete.ok) return erreur(tete.erreur);
      if (!tete.valeur) return { ok: true, valeur: { existe: false, sha: null, commits: [], fichiers: [] } };
      if (!base) {
        const c = await f.commits(nom(d), { branche: b, limite: 5 });
        return vers(c, (cs) => ({ existe: true, sha: tete.valeur, commits: cs.map((x) => ({ sha: x.sha, message: x.message, le: x.date ?? "" })), fichiers: [] }));
      }
      // LES FICHIERS TOUCHÉS se lisent par rapport à la BASE : une comparaison qui échoue est une erreur, jamais « aucun fichier ».
      const cmp = await f.comparer(nom(d), base, tete.valeur);
      return vers(cmp, (c) => ({ existe: true, sha: tete.valeur, commits: c.commits.map((x) => ({ sha: x.sha, message: x.message, le: x.date ?? "" })), fichiers: c.fichiers.map((x) => x.chemin) }));
    },
    pr: async (d, b) => vers(await f.prDeBranche(nom(d), b), (p) => p && ({
      numero: p.numero, url: p.url, mergeable: p.fusionnable, etat: p.fusionnee ? "fusionnee" as const : p.etat === "open" ? "ouverte" as const : "fermee" as const,
    })),
    checks: async (d, sha) => {
      const c = await f.checks(nom(d), sha);
      if (!c.ok) return erreur(c.erreur);
      const statut = ({ VERT: "vert", ROUGE: "rouge", EN_COURS: "en_cours", AUCUN: "aucun" } as const)[c.valeur.global];
      // L'EXTRAIT UTILE : la fin du journal des deux premiers jobs en échec (là où est l'erreur), borné.
      const echecs = await Promise.all(c.valeur.echecs.slice(0, 4).map(async (run, i) => {
        const j = i < 2 && run.jobId ? await f.journalDeJob(nom(d), run.jobId, 8_000) : null;
        return { nom: run.nom, url: run.url ?? "", extrait: j?.ok ? j.valeur.slice(-4_000) : `${run.nom} : ${run.conclusion ?? "échec"}` };
      }));
      return { ok: true, valeur: { statut, echecs } };
    },
    commenterPr: async (d, numero, texte) => vers(await f.commenterPr(nom(d), numero, texte), (x) => ({ url: x.url })),
    ouvrirPr: async () => nonPrisEnCharge("ouvrir une PR (Claude Code l'ouvre)"),
    fusionnerPr: async () => nonPrisEnCharge("fusionner une PR (fusion à la main après validation)"),
    fichier: async () => nonPrisEnCharge("lire un fichier"),
  };
}

function hebergeurDe(h: C2.Hebergeur | null, http: typeof fetch): Hebergeur {
  const absent = (): Extract<Resultat<never>, { ok: false }> => ({ ok: false, erreur: "Render non configuré (RENDER_API_KEY absente)", definitif: true });
  if (!h) {
    return {
      services: async () => absent(), deployer: async () => absent(), deploiement: async () => absent(), deploiements: async () => absent(),
      annuler: async () => absent(), rollback: async () => absent(), autoDeploy: async () => absent(), logs: async () => absent(),
      variablesNoms: async () => absent(), sante: (url, chemin) => sante(http, url, chemin),
    };
  }
  const trouverParSha = async (serviceId: string, sha: string): Promise<Resultat<DeploiementRender>> => {
    const l = await h.deploiements(serviceId, { limite: 10 });
    if (!l.ok) return erreur(l.erreur);
    const d = l.valeur.find((x) => x.sha === sha);
    return { ok: true, valeur: d ? deploiementDe(d) : { id: `${EN_FILE}${sha}`, statut: "queued", commit: sha, le: new Date().toISOString() } };
  };
  return {
    services: async () => vers(await h.services(), (ss) => ss.map((s) => ({
      id: s.id, nom: s.nom, type: s.type, url: s.url, branche: s.branche, autoDeploy: s.autoDeploy !== "off", healthCheckPath: s.cheminSante,
    }))),
    deployer: async (serviceId, sha) => {
      const r = await h.deployer(serviceId, { commitId: sha ?? null });
      if (!r.ok) return erreur(r.erreur);
      return r.valeur ? { ok: true, valeur: deploiementDe(r.valeur) } : { ok: true, valeur: { id: `${EN_FILE}${sha ?? ""}`, statut: "queued", commit: sha ?? null, le: new Date().toISOString() } };
    },
    deploiement: async (serviceId, id) => (id.startsWith(EN_FILE) ? trouverParSha(serviceId, id.slice(EN_FILE.length)) : vers(await h.deploiement(serviceId, id), deploiementDe)),
    deploiements: async (serviceId, n) => vers(await h.deploiements(serviceId, { limite: n }), (ds) => ds.map(deploiementDe)),
    annuler: async (serviceId, id) => vers(await h.annuler(serviceId, id), deploiementDe),
    rollback: async (serviceId, id) => vers(await h.rollback(serviceId, id), deploiementDe),
    autoDeploy: async (serviceId, actif) => vers(await h.reglerAutoDeploy(serviceId, actif ? "commit" : "off"), (s) => ({ autoDeploy: s.autoDeploy !== "off" })),
    logs: async (serviceId, depuis, filtre) => {
      const s = await h.service(serviceId);
      if (!s.ok) return erreur(s.erreur);
      if (!s.valeur.proprietaireId) return { ok: false, erreur: "propriétaire du service inconnu : journaux illisibles", definitif: true };
      const j = await h.journaux({ proprietaireId: s.valeur.proprietaireId, serviceId, debut: depuis, ...(filtre?.niveau ? { niveaux: [filtre.niveau] } : {}), ...(filtre?.texte ? { texte: [filtre.texte] } : {}), limite: filtre?.limite ?? 50 });
      return vers(j, (p) => p.lignes.map((l) => ({ le: l.date, niveau: l.niveau ?? "", message: l.message })));
    },
    variablesNoms: async (serviceId) => vers(await h.nomsDesVariables(serviceId), (x) => x),
    sante: (url, chemin) => sante(http, url, chemin),
  };
}

/** LA SANTÉ : un GET public, 10 s au plus, rien de plus (la doctrine : déterministe d'abord, E2E lourd seulement si le risque le demande). */
async function sante(http: typeof fetch, url: string, chemin: string): Promise<Resultat<{ statut: number; ms: number }>> {
  const debut = Date.now();
  try {
    const r = await http(new URL(chemin || "/", url).toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return { ok: true, valeur: { statut: r.status, ms: Date.now() - debut } };
  } catch (e) {
    return { ok: false, erreur: `santé injoignable : ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` };
  }
}

function agentDe(a: C2.AgentDeveloppeur, env: Env): AgentDeveloppeur {
  // La routine DU dépôt (`CLAUDE_ROUTINE_<ALIAS>_DEPOT`) ; à défaut, la seule routine configurée ; sinon aucune (dit).
  const alias = (d: RefDepot): string | null => {
    const seules = a.routines();
    return routineDuDepot(nom(d), env)?.alias ?? (seules.length === 1 ? seules[0]! : null);
  };
  const session = (s: C2.SessionLancee, moyen: "routine" | "commentaire-pr") => ({
    sessionId: s.sessionId ?? (s.commentaireId ? `commentaire-${s.commentaireId}` : s.cleIdempotence), url: s.sessionUrl ?? s.commentaireUrl ?? "",
    lanceeLe: new Date().toISOString(), moyen,
  });
  const lancer: AgentDeveloppeur["lancer"] = async (c, cle) => {
    const a2 = alias(c.depot);
    if (!a2) return { ok: false, erreur: `aucune routine Claude Code pour ${nom(c.depot)} (CLAUDE_ROUTINE_<ALIAS>_ID / _TOKEN / _DEPOT)`, definitif: true };
    const texte = construireConsigne({ depot: nom(c.depot), branche: c.branche, objectif: c.objectif, perimetre: c.perimetre, criteres: c.criteres, commandes: c.commandesVerif, contexte: c.contexte ?? null });
    return vers(await a.lancer({ alias: a2, texte, cleIdempotence: cle, missionId: c.chantierId }), (s) => session(s, "routine"));
  };
  return {
    disponible: async () => {
      const routines = a.routines();
      return routines.length ? { ok: true, moyens: ["routine", "commentaire-pr"] } : { ok: false, raison: "aucune routine Claude Code configurée (CLAUDE_ROUTINE_<ALIAS>_ID / _TOKEN)", moyens: ["commentaire-pr"] };
    },
    lancer,
    relancer: async (c, cle) => {
      if (c.pr) return vers(await a.relancerDansPr({ depot: nom(c.depot), numeroPr: c.pr, texte: c.probleme, cleIdempotence: cle, missionId: c.chantierId }), (s) => session(s, "commentaire-pr"));
      return lancer({ ...c, contexte: [c.contexte, `## Problème à corriger\n${c.probleme}`].filter(Boolean).join("\n\n") }, cle);
    },
  };
}

/** LES PORTS DU MOTEUR depuis les connecteurs de C2. Sans forge (GitHub non configuré), aucun chantier ne peut être vérifié : `null`. */
export function portsDepuisConnecteurs(c: { agent: C2.AgentDeveloppeur; forge: C2.ForgeGit | null; hebergeur: C2.Hebergeur | null }, o: { env?: Env; fetch?: typeof fetch } = {}): PortsDev | null {
  if (!c.forge) return null;
  return { agent: agentDe(c.agent, o.env ?? process.env), forge: forgeDe(c.forge), hebergeur: hebergeurDe(c.hebergeur, o.fetch ?? fetch) };
}
