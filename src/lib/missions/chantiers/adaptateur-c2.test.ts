import { describe, expect, it } from "vitest";
import type * as C2 from "@/platform/dev/ports";
import { portsDepuisConnecteurs } from "@/lib/missions/chantiers/adaptateur-c2";

/**
 * L'ADAPTATEUR C2 → MOTEUR (lot C1, décision 0042) — les connecteurs réels traduits dans les termes du moteur, sans réseau :
 * fichiers lus par COMPARAISON avec la base, extrait d'erreur tiré du journal du job, déploiement « en file » retrouvé par
 * son SHA, relance dans le fil de la PR avec la clé d'idempotence, `INCERTAIN` jamais relancé, routine choisie par dépôt.
 */

const ok = <T>(valeur: T): C2.Resultat<T> => ({ ok: true, valeur });
const ko = (code: C2.CodeErreur, reessayable = false): C2.Resultat<never> => ({ ok: false, erreur: { code, message: `erreur ${code}`, reessayable } });
const depot = { proprietaire: "aminedjm", nom: "amd-internal-os" };
const appels: { quoi: string; args: unknown }[] = [];

const forge = {
  moi: async () => ok({ login: "direction", type: "User", nom: null }),
  depot: async () => ok({ nom: "aminedjm/amd-internal-os" as C2.NomDepot, brancheParDefaut: "main", prive: true, peutPousser: true, archive: false }),
  teteDeBranche: async (_d: string, b: string) => ok(b === "claude/x" ? "abc1234567" : b === "main" ? "fff0000000" : null),
  commits: async () => ok([]),
  comparer: async (_d: string, base: string, tete: string) => { appels.push({ quoi: "comparer", args: [base, tete] }); return ok({ statut: "ahead", enAvance: 1, enRetard: 0, commits: [{ sha: tete, message: "m", auteur: null, date: "2026-11-01", url: null }], fichiers: [{ chemin: "src/a.ts", statut: "modified", ajouts: 1, suppressions: 0 }] }); },
  prDeBranche: async () => ok({ numero: 7, titre: "t", etat: "open" as const, fusionnee: false, brouillon: false, fusionnable: true, etatFusion: null, branche: "claude/x", base: "main", shaTete: "abc", url: "https://github.com/pr/7", auteur: null }),
  pr: async () => ko("INTROUVABLE"),
  checks: async (_d: string, sha: string) => ok({ sha, global: "ROUGE" as const, runs: [], echecs: [{ id: 1, nom: "tests", statut: "completed", conclusion: "failure" as const, url: "https://ci/1", jobId: 99 }] }),
  journalDeJob: async () => ok(`${"x".repeat(5_000)}\nFAIL src/a.test.ts attendu 1 reçu 2`),
  commenterPr: async () => ok({ id: 1, url: "u" }),
  relancerEchecs: async () => ok(true as const),
} satisfies C2.ForgeGit;

const deploiements: C2.Deploiement[] = [{ id: "dep-2", statut: "build_in_progress", sha: "abc1234567", messageCommit: null, declencheur: "api", creeLe: "2026-11-01T10:00:00Z", termineLe: null }];
const hebergeur = {
  services: async () => ok([{ id: "srv", nom: "ERP", type: "web_service", depot: null, branche: "main", autoDeploy: "commit" as const, suspendu: false, url: "https://erp.test", tableauDeBord: null, proprietaireId: "own", cheminSante: "/api/health" }]),
  service: async () => ok({ id: "srv", nom: "ERP", type: "web_service", depot: null, branche: "main", autoDeploy: "commit" as const, suspendu: false, url: "https://erp.test", tableauDeBord: null, proprietaireId: "own", cheminSante: "/api/health" }),
  deploiements: async () => ok(deploiements),
  deploiement: async (_s: string, id: string) => ok({ ...deploiements[0]!, id }),
  deployer: async () => ok(null),
  annuler: async () => ko("INCONNU"),
  rollback: async () => ko("INCONNU"),
  journaux: async (o: { proprietaireId: string }) => { appels.push({ quoi: "journaux", args: o }); return ok({ lignes: [{ id: "1", date: "d", message: "boom", niveau: "error", type: "app" }], encore: false, suivantDebut: null, suivantFin: null }); },
  nomsDesVariables: async () => ok(["mimo"]),
  reglerAutoDeploy: async (_s: string, d: C2.DeclencheurAutoDeploy) => ok({ id: "srv", nom: "ERP", type: "w", depot: null, branche: null, autoDeploy: d, suspendu: false, url: null, tableauDeBord: null, proprietaireId: null, cheminSante: null }),
  evenement: async () => ko("INCONNU"),
} satisfies C2.Hebergeur;

const agent: C2.AgentDeveloppeur = {
  lancer: async (d) => { appels.push({ quoi: "lancer", args: d }); return d.cleIdempotence === "incertaine" ? ko("INCERTAIN") : ok({ moyen: "ROUTINE", sessionId: "s1", sessionUrl: "https://claude.ai/code/s1", deja: false, cleIdempotence: d.cleIdempotence }); },
  relancerDansPr: async (d) => { appels.push({ quoi: "relancerDansPr", args: d }); return ok({ moyen: "COMMENTAIRE_PR", sessionId: null, sessionUrl: null, commentaireId: 42, commentaireUrl: "https://github.com/pr/7#42", deja: false, cleIdempotence: d.cleIdempotence }); },
  routines: () => ["AMD"],
};

const env = { CLAUDE_ROUTINE_AMD_ID: "trig_1", CLAUDE_ROUTINE_AMD_TOKEN: "sk-x", CLAUDE_ROUTINE_AMD_DEPOT: "aminedjm/amd-internal-os" };
const http = (async (u: string) => { appels.push({ quoi: "sante", args: u }); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch;
const ports = portsDepuisConnecteurs({ agent, forge, hebergeur }, { env, fetch: http })!;
const consigne = { depot, branche: "claude/x", brancheBase: "main", objectif: "o", perimetre: ["src/**"], criteres: ["c"], commandesVerif: ["npm test"], chantierId: "ch1" };

describe("adaptateur C2 → moteur des chantiers", () => {
  it("sans GitHub, rien n'est branché", () => {
    expect(portsDepuisConnecteurs({ agent, forge: null, hebergeur })).toBeNull();
  });

  it("la branche : SHA de tête, fichiers lus par comparaison avec la base ; absente → existe: false", async () => {
    expect(await ports.forge.branche(depot, "claude/x", "main")).toEqual({ ok: true, valeur: { existe: true, sha: "abc1234567", commits: [{ sha: "abc1234567", message: "m", le: "2026-11-01" }], fichiers: ["src/a.ts"] } });
    expect(appels.find((a) => a.quoi === "comparer")?.args).toEqual(["main", "abc1234567"]);
    expect(await ports.forge.branche(depot, "claude/absente", "main")).toMatchObject({ ok: true, valeur: { existe: false, sha: null } });
  });

  it("les checks : verdict traduit, extrait = la FIN du journal du job en échec", async () => {
    const r = await ports.forge.checks(depot, "abc1234567");
    expect(r.ok && r.valeur.statut).toBe("rouge");
    expect(r.ok && r.valeur.echecs[0]!.extrait.endsWith("FAIL src/a.test.ts attendu 1 reçu 2")).toBe(true);
    expect(r.ok && r.valeur.echecs[0]!.extrait.length).toBeLessThanOrEqual(4_000);
  });

  it("la PR : ouverte, fusionnable ; ouvrir et fusionner sont « non pris en charge » (définitif), jamais simulés", async () => {
    expect(await ports.forge.pr(depot, "claude/x")).toEqual({ ok: true, valeur: { numero: 7, url: "https://github.com/pr/7", mergeable: true, etat: "ouverte" } });
    expect(await ports.forge.fusionnerPr(depot, 7)).toMatchObject({ ok: false, definitif: true });
  });

  it("un déploiement « en file » (202) se retrouve ensuite par son SHA ; journaux par le propriétaire ; autoDeploy coupé", async () => {
    const d = await ports.hebergeur.deployer("srv", "abc1234567");
    expect(d).toMatchObject({ ok: true, valeur: { id: "file:abc1234567", statut: "queued" } });
    expect(await ports.hebergeur.deploiement("srv", "file:abc1234567")).toMatchObject({ ok: true, valeur: { id: "dep-2", statut: "build_in_progress", commit: "abc1234567" } });
    expect(await ports.hebergeur.logs("srv", "2026-11-01T10:00:00Z", { niveau: "error", limite: 20 })).toEqual({ ok: true, valeur: [{ le: "d", niveau: "error", message: "boom" }] });
    expect(appels.find((a) => a.quoi === "journaux")?.args).toMatchObject({ proprietaireId: "own", serviceId: "srv", niveaux: ["error"] });
    expect(await ports.hebergeur.autoDeploy("srv", false)).toEqual({ ok: true, valeur: { autoDeploy: false } });
    expect(await ports.hebergeur.sante("https://erp.test", "/api/health")).toMatchObject({ ok: true, valeur: { statut: 200 } });
    expect(appels.find((a) => a.quoi === "sante")?.args).toBe("https://erp.test/api/health");
  });

  it("Claude Code : la routine du dépôt, la consigne construite par C2, la clé d'idempotence transmise ; relance dans le fil de la PR", async () => {
    const l = await ports.agent.lancer(consigne, "ch1|lancer|lancement");
    expect(l).toMatchObject({ ok: true, valeur: { sessionId: "s1", url: "https://claude.ai/code/s1", moyen: "routine" } });
    const envoye = appels.find((a) => a.quoi === "lancer")!.args as C2.DemandeLancement;
    expect(envoye).toMatchObject({ alias: "AMD", cleIdempotence: "ch1|lancer|lancement", missionId: "ch1" });
    expect(envoye.texte).toMatch(/Travaille UNIQUEMENT sur la branche `claude\/x`/);
    const r = await ports.agent.relancer({ ...consigne, probleme: "corrige le test", pr: 7 }, "ch1|corriger|tour-1");
    expect(r).toMatchObject({ ok: true, valeur: { moyen: "commentaire-pr", url: "https://github.com/pr/7#42" } });
    expect(appels.find((a) => a.quoi === "relancerDansPr")!.args).toMatchObject({ numeroPr: 7, texte: "corrige le test", cleIdempotence: "ch1|corriger|tour-1" });
  });

  it("INCERTAIN (la requête a pu partir) remonte comme tel : jamais « définitif », jamais réessayé en silence", async () => {
    expect(await ports.agent.lancer(consigne, "incertaine")).toMatchObject({ ok: false, incertain: true, definitif: false });
    const sans = portsDepuisConnecteurs({ agent, forge, hebergeur }, { env: {}, fetch: http })!;
    expect(await sans.agent.lancer(consigne, "k")).toMatchObject({ ok: true });
    const aucune = portsDepuisConnecteurs({ agent: { ...agent, routines: () => [] }, forge, hebergeur }, { env: { CLAUDE_ROUTINE_A_ID: "1", CLAUDE_ROUTINE_B_ID: "2" }, fetch: http })!;
    expect(await aucune.agent.lancer(consigne, "k")).toMatchObject({ ok: false, definitif: true });
    expect(await aucune.agent.disponible()).toMatchObject({ ok: false });
  });
});
