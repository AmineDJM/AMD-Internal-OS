import { describe, expect, it } from "vitest";
import { compilerChantier, etapesParDefaut, gestesCritiques, lirePlanChantier } from "@/lib/missions/chantiers/plan";
import { deciderAntiBoucle, delaiCroissantMs, estMigrationSql, gesteDestructif, lireReglagesChantiers, migrationDestructive, motifBudgetChantier, reglagesDuPlan, REGLAGES_CHANTIERS_DEFAUT, signatureEchec } from "@/lib/missions/chantiers/regles";
import { routerModele, SEUIL_LECTURE_SANS_MODELE } from "@/lib/missions/chantiers/routeur";
import { correspond, globsSeRecouvrent, horsPerimetre, perimetresSeRecouvrent } from "@/lib/missions/chantiers/perimetre";
import { composerRapport, dossierInitial, jugerPreuves } from "@/lib/missions/chantiers/dossier";
import { evaluerCondition } from "@/lib/missions/runtime/condition";
import { appelerMimo, configMimo, coutMimo, MIMO_BASE_DEFAUT, MIMO_MODELE_DEFAUT, sonderMimo } from "@/lib/models/mimo";
import { setModelCallSink } from "@/lib/models/telemetry";

/**
 * LES RÈGLES PURES DES CHANTIERS (lot C1, décision 0042) — le DSL du plan (catalogue fermé, enchaînements interdits),
 * l'anti-boucle (Sol au 2ᵉ échec identique, blocage au 3ᵉ), les budgets, le routeur de modèles (déterministe →
 * MiMo → Terra → Sol), le recouvrement de périmètres, le juge des preuves, et l'adaptateur MiMo (sans réseau).
 */

const base = {
  titre: "Ajouter la page santé", objectif: "Une route /api/sante qui rend 200.",
  depot: { proprietaire: "aminedjm", nom: "amd-internal-os" }, branche: "claude/sante",
  perimetre: ["src/app/api/sante/**"], criteres: ["GET /api/sante rend 200"], commandesVerif: ["npm test"],
};
const erp = { id: "srv-erp", nom: "ERP", role: "erp", production: false };
const app = { id: "srv-app", nom: "App", role: "app", production: true, branche: "main" };

describe("plan d'un chantier — DSL compilé, refusé hors catalogue", () => {
  it("sans étapes, le plan type est posé : lancer, attendre, vérifier, corriger si rouge, fusionner, ERP puis app, rapport", () => {
    const r = lirePlanChantier({ ...base, services: [app, erp] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types = r.plan.etapes.map((e) => `${e.type}${e.service ? `:${e.service}` : ""}`);
    expect(types).toEqual([
      "DEV_LANCER", "DEV_ATTENDRE", "DEV_VERIFIER", "DEV_CORRIGER", "DEV_FUSIONNER",
      "RENDER_DEPLOYER:srv-erp", "RENDER_VERIFIER:srv-erp", "RENDER_ROLLBACK:srv-erp",
      "RENDER_DEPLOYER:srv-app", "RENDER_VERIFIER:srv-app", "RENDER_ROLLBACK:srv-app", "RAPPORT",
    ]);
    expect(gestesCritiques(r.plan)).toEqual([
      "Fusionner la PR dans main (carte écrite ou orale ; compensable par une PR de revert)", "Déployer App en production", "Rollback de production, si la santé l'exige",
    ]);
    // Sans fusion (`fusion: false`), un déploiement sur la branche de base n'a rien à déployer : refusé à la lecture.
    const sansFusion = lirePlanChantier({ ...base, services: [app], fusion: false });
    expect(!sansFusion.ok && sansFusion.fautes.join(" ")).toMatch(/fusion/i);
  });

  it("refuse un type hors catalogue, main comme branche, un périmètre vide, un déploiement avant vérification", () => {
    const hors = lirePlanChantier({ ...base, etapes: [{ cle: "lancer", type: "DEV_LANCER" }, { cle: "x", type: "SUPPRIMER_PROD" }, { cle: "rapport", type: "RAPPORT" }] });
    expect(hors.ok).toBe(false);
    expect(!hors.ok && hors.fautes.join(" ")).toMatch(/hors catalogue/);
    const main = lirePlanChantier({ ...base, branche: "main" });
    expect(!main.ok && main.fautes.join(" ")).toMatch(/jamais sur la branche de base ni sur main/);
    expect(lirePlanChantier({ ...base, perimetre: [] }).ok).toBe(false);
    const tot = lirePlanChantier({
      ...base, services: [erp],
      etapes: [{ cle: "lancer", type: "DEV_LANCER" }, { cle: "dep", type: "RENDER_DEPLOYER", service: "srv-erp", apres: ["lancer"] }, { cle: "verif", type: "DEV_VERIFIER", apres: ["dep"] }, { cle: "rapport", type: "RAPPORT", apres: ["verif"] }],
    });
    expect(!tot.ok && tot.fautes.join(" ")).toMatch(/aucun déploiement avant la vérification/);
  });

  it("l'app ne se déploie jamais avant l'ERP du même plan (migrations)", () => {
    const r = lirePlanChantier({
      ...base, services: [erp, { ...app, production: false, branche: undefined }],
      etapes: [
        { cle: "lancer", type: "DEV_LANCER" }, { cle: "verif", type: "DEV_VERIFIER", apres: ["lancer"] },
        { cle: "app", type: "RENDER_DEPLOYER", service: "srv-app", apres: ["verif"] }, { cle: "erp", type: "RENDER_DEPLOYER", service: "srv-erp", apres: ["app"] },
        { cle: "rapport", type: "RAPPORT", apres: ["erp"] },
      ],
    });
    expect(!r.ok && r.fautes.join(" ")).toMatch(/l'ERP .* se déploie AVANT/);
  });

  it("compile en nœuds WORKER du moteur : chaque étape dépend aussi de DEV_LANCER, la condition `si` devient un `when`", () => {
    const r = lirePlanChantier({ ...base, services: [erp] });
    if (!r.ok) throw new Error(r.fautes.join(" "));
    const c = compilerChantier(r.plan);
    expect(c.steps.every((s) => s.nodeType === "WORKER" && s.capability === null)).toBe(true);
    const corriger = c.steps.find((s) => s.key === "corriger")!;
    expect(corriger.dependsOn).toEqual(expect.arrayContaining(["verifier", "lancer"]));
    expect(corriger.spec?.when).toEqual({ step: "verifier", path: "vert", op: "eq", value: "false" });
    // La condition lue par le moteur : corriger SEULEMENT si la vérification est rouge.
    expect(evaluerCondition(corriger.spec!.when!, { status: "DONE", result: { vert: false } }).remplie).toBe(true);
    expect(evaluerCondition(corriger.spec!.when!, { status: "DONE", result: { vert: true } }).remplie).toBe(false);
    expect(c.acceptance).toContain("GET /api/sante rend 200");
  });

  it("le plan par défaut sans service : aucune étape RENDER_*", () => {
    expect(etapesParDefaut([]).map((e) => e.type)).toEqual(["DEV_LANCER", "DEV_ATTENDRE", "DEV_VERIFIER", "DEV_CORRIGER", "DEV_FUSIONNER", "RAPPORT"]);
    expect(etapesParDefaut([], false).map((e) => e.type)).toEqual(["DEV_LANCER", "DEV_ATTENDRE", "DEV_VERIFIER", "DEV_CORRIGER", "RAPPORT"]);
  });
});

describe("anti-boucle, délai croissant, budgets", () => {
  const sig = signatureEchec({ etape: "verifier", check: "tests", erreur: "FAIL src/a.test.ts:12 attendu 3 reçu 4 (sha 9f3c2ab)" });

  it("la signature ignore SHA, nombres et horodatage : deux échecs qui ne diffèrent que par là sont le même", () => {
    expect(signatureEchec({ etape: "verifier", check: "Tests", erreur: "FAIL src/a.test.ts:57 attendu 8 reçu 9 (sha 1a2b3c4d)\nsuite" })).toBe(sig);
    expect(signatureEchec({ etape: "verifier", check: "tests", erreur: "Type error in b.ts" })).not.toBe(sig);
  });

  it("ROUGE AUTONOME (Direction, 02/11) : corriger, Sol à la 2ᵉ même panne, alerte au 3ᵉ rouge SANS arrêt ; consignes au plafond ou si Sol n'a rien changé", () => {
    expect(deciderAntiBoucle({ historique: [], nouvelle: sig, tours: 0, correctionsMax: 8 })).toEqual({ action: "CORRIGER", occurrences: 1, alerte: false });
    expect(deciderAntiBoucle({ historique: [sig], nouvelle: sig, tours: 1, correctionsMax: 8 })).toMatchObject({ action: "ESCALADER_SOL", alerte: false });
    // Le 3ᵉ ROUGE (deux corrections ratées) : la Direction est prévenue, la boucle CONTINUE.
    expect(deciderAntiBoucle({ historique: ["a", "b"], nouvelle: "c", tours: 2, correctionsMax: 8 })).toEqual({ action: "CORRIGER", occurrences: 1, alerte: true });
    expect(deciderAntiBoucle({ historique: ["a", "b"], nouvelle: "c", tours: 2, correctionsMax: 8, alerteApresEchecs: 5 })).toMatchObject({ alerte: false });
    // Ni un 3ᵉ, ni un 5ᵉ rouge n'arrêtent : seul le plafond (8) ou la même panne APRÈS Sol demandent les consignes.
    expect(deciderAntiBoucle({ historique: ["a", "b", "c", "d"], nouvelle: "e", tours: 4, correctionsMax: 8 }).action).toBe("CORRIGER");
    expect(deciderAntiBoucle({ historique: [sig, sig], nouvelle: sig, tours: 2, correctionsMax: 8, solDejaPour: [sig] })).toMatchObject({ action: "CONSIGNES", occurrences: 3 });
    expect(deciderAntiBoucle({ historique: ["a", "b", "c", "d", "e", "f", "g", "h"], nouvelle: "i", tours: 8, correctionsMax: 8 })).toMatchObject({ action: "CONSIGNES", raison: expect.stringMatching(/8 corrections sur 8/) });
  });

  it("le délai croît : 1, 2, 4, 8 min… plafonné", () => {
    expect([1, 2, 3, 4].map((n) => delaiCroissantMs(n) / 60_000)).toEqual([1, 2, 4, 8]);
    expect(delaiCroissantMs(20)).toBe(30 * 60_000);
  });

  it("un plafond mord AVANT le geste : coût du chantier, du jour, lancements et déploiements", () => {
    const c = { coutUsd: 1, lancements: 2, deploiements: 0, jourUsd: 3, jourLancements: 5, jourDeploiements: 1 };
    const r = { ...REGLAGES_CHANTIERS_DEFAUT, lancementsMax: 3 };
    expect(motifBudgetChantier(c, r, 5)).toBeNull();
    expect(motifBudgetChantier({ ...c, coutUsd: 5 }, r, 5)).toMatch(/plafond du chantier atteint/);
    expect(motifBudgetChantier({ ...c, lancements: 3 }, r, 5, "lancement")).toMatch(/3 lancements de Claude Code sur 3/);
    expect(motifBudgetChantier({ ...c, lancements: 3 }, r, 5, "deploiement")).toBeNull();
    expect(motifBudgetChantier({ ...c, jourUsd: 20 }, r, 5)).toMatch(/plafond du jour/);
  });

  it("les réglages de la console sont bornés, l'absent prend le défaut", () => {
    expect(lireReglagesChantiers({ plafondUsd: "7,5", tentativesMax: 99, enParallele: -1, autofixMinutes: "0" })).toMatchObject({ plafondUsd: 7.5, tentativesMax: 5, enParallele: 1, autofixMinutes: 0, lancementsMax: REGLAGES_CHANTIERS_DEFAUT.lancementsMax });
  });

  it("une migration destructive se reconnaît (validation exigée)", () => {
    expect(migrationDestructive('ALTER TABLE "X" DROP COLUMN "y";')).toBe(true);
    expect(migrationDestructive('ALTER TABLE "X" ADD COLUMN IF NOT EXISTS "y" TEXT;')).toBe(false);
  });
});

describe("routeur de modèles — le moins coûteux capable", () => {
  const tous = { mimo: true, terra: true, sol: true };
  it("un statut se lit sans modèle ; un extrait court se transmet tel quel", () => {
    expect(routerModele({ nature: "statut", disponibles: tous }).niveau).toBe("DETERMINISTE");
    expect(routerModele({ nature: "lecture", caracteres: SEUIL_LECTURE_SANS_MODELE, disponibles: tous }).niveau).toBe("DETERMINISTE");
  });
  it("un log long → MiMo ; une rédaction à risque haut → MiMo relu par Terra ; une décision → Terra", () => {
    expect(routerModele({ nature: "lecture", caracteres: 20_000, disponibles: tous }).niveau).toBe("MIMO");
    expect(routerModele({ nature: "redaction", risque: "haut", disponibles: tous })).toMatchObject({ niveau: "MIMO", relecture: true });
    expect(routerModele({ nature: "decision", disponibles: tous }).niveau).toBe("TERRA");
  });
  it("Sol seulement à l'escalade ou pour un arbitrage ; MiMo absent → Terra ; rien de branché → texte brut", () => {
    expect(routerModele({ nature: "lecture", caracteres: 20_000, escalade: true, disponibles: tous }).niveau).toBe("SOL");
    expect(routerModele({ nature: "arbitrage", disponibles: tous }).niveau).toBe("SOL");
    expect(routerModele({ nature: "lecture", caracteres: 20_000, disponibles: { mimo: false, terra: true, sol: true } }).niveau).toBe("TERRA");
    expect(routerModele({ nature: "lecture", caracteres: 20_000, disponibles: { mimo: false, terra: false, sol: false } }).niveau).toBe("DETERMINISTE");
    expect(routerModele({ nature: "arbitrage", escalade: true, disponibles: { mimo: true, terra: true, sol: false } }).niveau).toBe("TERRA");
  });
});

describe("périmètre — jamais deux chantiers au même endroit", () => {
  it("le recouvrement est conservateur ; des préfixes disjoints ne se recouvrent pas", () => {
    expect(globsSeRecouvrent("src/lib/**", "src/lib/missions/x.ts")).toBe(true);
    expect(globsSeRecouvrent("src/lib/missions/chantiers/**", "src/lib/missions/**")).toBe(true);
    expect(globsSeRecouvrent("src/app/**", "prisma/**")).toBe(false);
    expect(globsSeRecouvrent("src/lib", "src/libx/a.ts")).toBe(false);
    expect(globsSeRecouvrent("**/*.ts", "prisma/schema.prisma")).toBe(true);
    expect(perimetresSeRecouvrent(["docs/**", "src/app/api/sante/**"], ["src/app/**"])).toEqual({ a: "src/app/api/sante/**", b: "src/app/**" });
  });
  it("un fichier hors du périmètre réservé est nommé", () => {
    expect(correspond("src/app/api/sante/**", "src/app/api/sante/route.ts")).toBe(true);
    expect(correspond("src/lib/", "src/lib/a.ts")).toBe(true);
    expect(correspond("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(horsPerimetre(["src/app/api/sante/route.ts", "prisma/schema.prisma"], ["src/app/api/sante/**"])).toEqual(["prisma/schema.prisma"]);
  });
});

describe("juge des preuves — aucune réussite sans preuve", () => {
  const plan = (() => { const r = lirePlanChantier({ ...base, services: [erp] }); if (!r.ok) throw new Error(); return r.plan; })();
  it("REFUSE sans SHA vert, sans déploiement live, sans santé", () => {
    const d = dossierInitial(plan);
    const v = jugerPreuves(d, 0.12);
    expect(v.satisfait).toBe(false);
    expect(v.manquantes).toEqual(expect.arrayContaining(["aucun SHA aux checks verts", "srv-erp : aucun déploiement"]));
    d.vert = { sha: "abc1234def", le: "2026-11-01T10:00:00.000Z" };
    d.deploiements.push({ service: "srv-erp", nom: "ERP", deployId: "dep-1", commit: "abc1234def", statut: "live", le: "x" });
    expect(jugerPreuves(d, 0.12).manquantes).toEqual(["la PR n'est pas fusionnée dans la base (validation refusée ou en attente)", "ERP : santé non démontrée"]);
    // Le plan type fusionne : sans fusion prouvée, pas de « terminé ».
    d.fusion = { sha: "abc1234def", pr: 7, base: "main", le: "x" };
    expect(jugerPreuves(d, 0.12).manquantes).toEqual(["ERP : santé non démontrée"]);
    d.deploiements[0]!.sain = true;
    expect(jugerPreuves(d, 0.12)).toMatchObject({ satisfait: true });
    expect(jugerPreuves({ ...d, shaVu: "fff9999" }, 0.12).satisfait).toBe(false);
  });
  it("le rapport dit SHA, PR, sessions, déploiements, santé et coût — composé par le code", () => {
    const d = dossierInitial(plan);
    d.vert = { sha: "abc1234def", le: "le" };
    d.pr = { numero: 7, url: "https://github.com/pr/7" };
    d.deploiements.push({ service: "srv-erp", nom: "ERP", deployId: "dep-1", commit: "abc1234def", statut: "live", le: "x", sante: { statut: 200, ms: 40, le: "x" }, sain: true });
    const t = composerRapport(d, 0.0312, "LIVRE");
    expect(t).toMatch(/livré et vérifié/);
    expect(t).toMatch(/Checks verts sur abc1234def/);
    expect(t).toMatch(/PR #7/);
    expect(t).toMatch(/santé HTTP 200/);
    expect(t).toMatch(/0,0312 \$/);
  });
});

describe("adaptateur MiMo — OpenAI-compatible, par la passerelle, clé jamais exposée", () => {
  it("lit la clé dans `mimo` (Render), la base et le modèle par défaut repris de l'ancien code", () => {
    expect(configMimo({ mimo: " tp-secret " })).toMatchObject({ cle: "tp-secret", base: MIMO_BASE_DEFAUT, modele: MIMO_MODELE_DEFAUT, prixEntreeParM: null });
    expect(configMimo({ MIMO: "k", MIMO_BASE_URL: "https://x/v1/", MIMO_MODEL: "m" })).toMatchObject({ cle: "k", base: "https://x/v1", modele: "m" });
    expect(coutMimo(1_000_000, 0, { prixEntreeParM: null, prixSortieParM: null })).toBeNull();
    expect(coutMimo(1_000_000, 500_000, { prixEntreeParM: 0.5, prixSortieParM: 2 })).toBe(1.5);
  });

  it("appelle /chat/completions, journalise l'usage (K8) et ne renvoie jamais la clé", async () => {
    const recus: { provider: string; model: string; inputTokens: number; costUsd: number | null }[] = [];
    setModelCallSink((u) => { recus.push(u as never); });
    try {
      let url = "";
      let auth = "";
      const f = (async (u: string, init: RequestInit) => {
        url = u;
        auth = String((init.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify({ choices: [{ message: { content: "Erreur utile : test x" } }], usage: { prompt_tokens: 1200, completion_tokens: 80 } }), { status: 200 });
      }) as unknown as typeof fetch;
      const r = await appelerMimo({ systeme: "s", texte: "t" }, { fetch: f, env: { mimo: "tp-cle-secrete-123456", MIMO_PRICE_IN: "0.4", MIMO_PRICE_OUT: "1.6" } });
      expect(url).toBe(`${MIMO_BASE_DEFAUT}/chat/completions`);
      expect(auth).toBe("Bearer tp-cle-secrete-123456");
      expect(r).toMatchObject({ ok: true, texte: "Erreur utile : test x", usage: { entree: 1200, sortie: 80 } });
      expect(recus.at(-1)).toMatchObject({ provider: "mimo", model: MIMO_MODELE_DEFAUT, inputTokens: 1200 });
      const ko = await appelerMimo({ systeme: "s", texte: "t" }, {
        fetch: (async () => new Response(JSON.stringify({ error: { message: "bad key tp-cle-secrete-123456" } }), { status: 401 })) as unknown as typeof fetch,
        env: { mimo: "tp-cle-secrete-123456" },
      });
      expect(ko.ok).toBe(false);
      expect(JSON.stringify(ko)).not.toContain("tp-cle-secrete-123456");
    } finally {
      setModelCallSink(null);
    }
  });

  it("sans clé : refus local, aucun réseau ; la sonde /v1/models dit si le modèle configuré existe", async () => {
    expect(await appelerMimo({ systeme: "s", texte: "t" }, { env: {} })).toMatchObject({ ok: false, configure: false });
    const f = (async () => new Response(JSON.stringify({ data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2-flash" }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await sonderMimo({ fetch: f, env: { mimo: "k" } })).toEqual({ ok: true, modeles: ["mimo-v2.6-pro", "mimo-v2-flash"], configure: "mimo-v2.6-pro", present: true });
  });

  it("le budget du plan ne fait que RESSERRER la console (C2) ; une migration se reconnaît, son geste destructeur se nomme", () => {
    const r = reglagesDuPlan(REGLAGES_CHANTIERS_DEFAUT, { usd: 2, lancements: 1, deploiements: 9, tentatives: 2 });
    expect([r.plafondUsd, r.lancementsMax, r.deploiementsMax, r.tentativesMax]).toEqual([2, 1, REGLAGES_CHANTIERS_DEFAUT.deploiementsMax, 2]);
    expect(reglagesDuPlan(REGLAGES_CHANTIERS_DEFAUT, {})).toEqual(REGLAGES_CHANTIERS_DEFAUT);
    expect(reglagesDuPlan(REGLAGES_CHANTIERS_DEFAUT, null)).toEqual(REGLAGES_CHANTIERS_DEFAUT);
    // Le plafond du CHANTIER (fixé à la proposition) ne dépasse jamais celui de la console en vigueur.
    const conso = { coutUsd: 6, jourUsd: 0, lancements: 0, jourLancements: 0, deploiements: 0, jourDeploiements: 0 };
    expect(motifBudgetChantier(conso, REGLAGES_CHANTIERS_DEFAUT, 50)).toMatch(/plafond du chantier atteint/);
    expect(estMigrationSql("prisma/migrations/20270301000000_x/migration.sql")).toBe(true);
    expect(estMigrationSql("src/lib/migrations-appliquees.ts")).toBe(false);
    expect(gesteDestructif('ALTER TABLE "X" DROP COLUMN "y";')).toBe('ALTER TABLE "X" DROP');
    expect(gesteDestructif("truncate table x")).toBe("TRUNCATE");
    expect(gesteDestructif('CREATE TABLE IF NOT EXISTS "Z" ("id" TEXT);')).toBeNull();
  });
});
