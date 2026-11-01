import type {
  AgentDeveloppeur, ConsigneDev, DeploiementRender, EtatChecks, ForgeGit, Hebergeur, RefDepot, Resultat, SessionDev,
} from "@/lib/missions/chantiers/ports-moteur";
import type { PortsDev } from "@/lib/missions/chantiers/etapes";

/**
 * LES DOUBLES EN MÉMOIRE DES PORTS DE DÉVELOPPEMENT — RÉSERVÉS AUX TESTS (`chantiers/*.test.ts`, banc de processus).
 * Une forge, un hébergeur et un Claude Code scriptables : chaque lancement ou relance appelle `surSession`, qui
 * « pousse » ce que la session aurait poussé (un SHA, des fichiers, l'état des checks). Aucun réseau.
 */

const ok = <T>(valeur: T): Resultat<T> => ({ ok: true, valeur });

export interface ScenarioDev {
  /** Ce que fait la session n° `n` (1 = le lancement, 2 = la première correction…) : rend le SHA poussé et ses checks. */
  surSession?: (n: number, c: ConsigneDev & { probleme?: string }) => { sha: string; checks: EtatChecks["statut"]; extrait?: string; fichiers?: string[] } | null;
  /** Statut final d'un déploiement (défaut « live »). */
  deploiement?: (serviceId: string, n: number) => string;
  /** Code HTTP de santé (défaut 200). */
  sante?: (url: string, n: number) => number;
  logsErreurs?: number;
}

export interface FauxPorts extends PortsDev {
  journal: { quoi: string; detail: unknown }[];
  pousser(branche: string, sha: string, checks: EtatChecks["statut"], extrait?: string, fichiers?: string[]): void;
}

export function fauxPortsDev(s: ScenarioDev = {}): FauxPorts {
  const journal: { quoi: string; detail: unknown }[] = [];
  const branches = new Map<string, { sha: string; fichiers: string[] }>();
  const checks = new Map<string, { statut: EtatChecks["statut"]; extrait: string }>();
  const prs = new Map<string, { numero: number; url: string; etat: "ouverte" | "fusionnee" | "fermee" }>();
  const deploiements = new Map<string, DeploiementRender[]>();
  let sessions = 0;
  let santes = 0;
  const pousser = (branche: string, sha: string, statut: EtatChecks["statut"], extrait = "", fichiers = ["src/lib/missions/chantiers/exemple.ts"]) => {
    branches.set(branche, { sha, fichiers });
    checks.set(sha, { statut, extrait });
  };
  const session = (c: ConsigneDev & { probleme?: string; pr?: number }): Resultat<SessionDev> => {
    sessions += 1;
    if (!("pr" in c && c.pr)) journal.push({ quoi: sessions === 1 ? "lancer" : "relancer", detail: { branche: c.branche, probleme: c.probleme ?? null } });
    const effet = s.surSession?.(sessions, c);
    if (effet) pousser(c.branche, effet.sha, effet.checks, effet.extrait, effet.fichiers);
    return ok({ sessionId: `session-${sessions}`, url: `https://claude.ai/code/session-${sessions}`, lanceeLe: new Date().toISOString(), moyen: "routine" });
  };
  const agent: AgentDeveloppeur = {
    disponible: async () => ({ ok: true, moyens: ["routine", "commentaire-pr"] }),
    lancer: async (c) => session(c),
    // Une PR existe : la relance part dans son fil (commentaire `@claude`, comme le connecteur réel) ; sinon une session neuve.
    relancer: async (c) => {
      if (!c.pr) return session(c);
      const r = session(c);
      journal.push({ quoi: "commenter", detail: { numero: c.pr, texte: `@claude ${c.probleme}` } });
      return r.ok ? ok({ ...r.valeur, moyen: "commentaire-pr", url: `https://github.com/pr/${c.pr}#commentaire-${sessions}` }) : r;
    },
  };
  const cle = (d: RefDepot, b: string) => `${d.proprietaire}/${d.nom}:${b}`;
  const forge: ForgeGit = {
    branche: async (_d, b) => {
      const x = branches.get(b);
      return ok({ existe: !!x, sha: x?.sha ?? null, commits: x ? [{ sha: x.sha, message: "travail", le: new Date().toISOString() }] : [], fichiers: x?.fichiers ?? [] });
    },
    pr: async (d, b) => ok(prs.has(cle(d, b)) ? { ...prs.get(cle(d, b))!, mergeable: true } : null),
    checks: async (_d, sha) => {
      const c = checks.get(sha);
      return ok({ statut: c?.statut ?? "aucun", echecs: c?.statut === "rouge" ? [{ nom: "tests", url: `https://ci/${sha}`, extrait: c.extrait }] : [] });
    },
    commenterPr: async (_d, numero, texte) => { journal.push({ quoi: "commentaire", detail: { numero, texte } }); return ok({ url: `https://github.com/pr/${numero}#c` }); },
    ouvrirPr: async (d, b) => {
      const p = { numero: prs.size + 1, url: `https://github.com/${d.proprietaire}/${d.nom}/pull/${prs.size + 1}`, etat: "ouverte" as const };
      prs.set(cle(d, b), p);
      journal.push({ quoi: "ouvrirPr", detail: { branche: b } });
      return ok({ numero: p.numero, url: p.url });
    },
    fusionnerPr: async (_d, numero) => {
      journal.push({ quoi: "fusionner", detail: { numero } });
      const sha = `fusion${numero}`.padEnd(12, "0");
      checks.set(sha, { statut: "vert", extrait: "" });
      return ok({ sha });
    },
    fichier: async () => ok({ octets: Buffer.from(""), mime: "text/plain" }),
  };
  const hebergeur: Hebergeur = {
    services: async () => ok([{ id: "srv-erp", nom: "ERP", type: "web_service", url: "https://erp.test", branche: "main", autoDeploy: true, healthCheckPath: "/api/health" }]),
    deployer: async (serviceId, commitSha) => {
      const liste = deploiements.get(serviceId) ?? [];
      const d: DeploiementRender = { id: `dep-${serviceId}-${liste.length + 1}`, statut: s.deploiement?.(serviceId, liste.length + 1) ?? "live", commit: commitSha ?? null, le: new Date().toISOString() };
      deploiements.set(serviceId, [d, ...liste]);
      journal.push({ quoi: "deployer", detail: { serviceId, commitSha } });
      return ok(d);
    },
    deploiement: async (serviceId, id) => {
      const d = (deploiements.get(serviceId) ?? []).find((x) => x.id === id);
      return d ? ok(d) : { ok: false, erreur: "introuvable", definitif: true };
    },
    deploiements: async (serviceId, n) => ok([...(deploiements.get(serviceId) ?? []), { id: `dep-${serviceId}-ancien`, statut: "deactivated", commit: "ancien000", le: "2026-10-01T00:00:00.000Z" }].slice(0, n)),
    annuler: async (serviceId, id) => ok({ id, statut: "canceled", commit: null, le: new Date().toISOString() }),
    rollback: async (serviceId, deployId) => {
      journal.push({ quoi: "rollback", detail: { serviceId, deployId } });
      const d: DeploiementRender = { id: `rb-${deployId}`, statut: "live", commit: "ancien000", le: new Date().toISOString() };
      deploiements.set(serviceId, [d, ...(deploiements.get(serviceId) ?? [])]);
      return ok(d);
    },
    autoDeploy: async (serviceId, actif) => { journal.push({ quoi: "autoDeploy", detail: { serviceId, actif } }); return ok({ autoDeploy: actif }); },
    logs: async () => ok(Array.from({ length: s.logsErreurs ?? 0 }, (_, i) => ({ le: new Date().toISOString(), niveau: "error", message: `erreur ${i}` }))),
    variablesNoms: async () => ok(["DATABASE_URL", "mimo"]),
    sante: async (url) => ok({ statut: s.sante?.(url, ++santes) ?? 200, ms: 42 }),
  };
  return { agent, forge, hebergeur, journal, pousser };
}
