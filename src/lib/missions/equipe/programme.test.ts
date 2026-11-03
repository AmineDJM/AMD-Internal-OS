import { describe, expect, it } from "vitest";
import { conflitsDeclares, lirePlanProgramme, regrouperPetitesTaches, type TacheProgramme } from "@/lib/missions/equipe/programme";
import { ordonnancer, type EtatTache } from "@/lib/missions/equipe/ordonnanceur";
import { recetteDeRegeneration, ressourcesDeTache, ressourcesDuFichier, ressourcesHorsReservation } from "@/lib/missions/equipe/ressources";
import { extraireJson, planifier } from "@/lib/missions/equipe/planificateur";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";

/**
 * O2 (décision 0059) — LES BRIQUES PURES : le validateur du plan (MiMo n'est jamais cru sur parole), les ressources
 * nommées (déclarées, déduites, VÉRIFIÉES au diff), l'ordonnanceur (parallèle quand c'est sûr, sérialisé sinon, budget),
 * le planificateur (MiMo, second essai avec les fautes, Sol en recours).
 */

const tache = (cle: string, o: Partial<TacheProgramme> = {}) => ({
  cle, titre: `Tâche ${cle}`, objectif: `Faire ${cle}`, perimetre: [`src/lib/${cle}/**`], criteres: [`la commande npm test -- ${cle} passe`],
  commandesVerif: [`npm test -- src/lib/${cle}`], ...o,
});
const plan = (taches: unknown[], o: Record<string, unknown> = {}) => ({ titre: "Programme", objectif: "Trois chantiers", depot: { proprietaire: "aminedjm", nom: "amd-internal-os" }, taches, ...o });
const lu = (p: unknown) => {
  const r = lirePlanProgramme(p);
  if (!r.ok) throw new Error(r.fautes.join(" | "));
  return r;
};

describe("validateur du plan de programme (déterministe)", () => {
  it("admet un plan propre, cible main par défaut, concurrence 3, travailleur cloud", () => {
    const r = lu(plan([tache("a"), tache("b"), tache("c")]));
    expect(r.plan.cible).toBe("main");
    expect(r.plan.concurrence).toBe(3);
    expect(r.plan.travailleur).toBe("claude-code-cloud");
    expect(r.conflits).toEqual([]);
  });

  it("refuse un cycle, une dépendance inconnue, l'auto-dépendance", () => {
    const r = lirePlanProgramme(plan([tache("a", { dependances: ["b"] }), tache("b", { dependances: ["a"] }), tache("c", { dependances: ["zz", "c"] })]));
    expect(r.ok).toBe(false);
    const f = !r.ok ? r.fautes.join(" ") : "";
    expect(f).toMatch(/Cycle de dépendances entre : a, b/);
    expect(f).toMatch(/dépend de « zz »/);
    expect(f).toMatch(/dépend d'elle-même/);
  });

  it("refuse un périmètre vide ou qui remonte, un critère vague, une tâche sans commande de vérification, une ressource inconnue", () => {
    const r = lirePlanProgramme(plan([
      tache("a", { perimetre: [] }), tache("b", { perimetre: ["../etc/**"] }), tache("c", { criteres: ["ça marche"] }),
      tache("d", { commandesVerif: [] }), { ...tache("e"), ressources: ["BASE"] },
    ]));
    const f = !r.ok ? r.fautes.join(" ") : "";
    expect(f).toMatch(/« a » : périmètre vide/);
    expect(f).toMatch(/« b » : un glob est relatif/);
    expect(f).toMatch(/critère « ça marche » invérifiable/);
    expect(f).toMatch(/« d » : aucune commande de vérification/);
    expect(f).toMatch(/ressource « BASE » inconnue/);
  });

  it("refuse tout déploiement, au programme comme à la tâche", () => {
    const r = lirePlanProgramme(plan([{ ...tache("a"), services: [{ id: "srv-erp" }] }], { deployer: true }));
    const f = !r.ok ? r.fautes.join(" ") : "";
    expect(f).toMatch(/Un programme ne déploie pas/);
    expect(f).toMatch(/« a » : un programme ne déploie pas/);
  });

  it("refuse un budget dépassé par les estimations et plus de tâches que de lancements", () => {
    const r = lirePlanProgramme(plan([tache("a", { coutEstimeUsd: 8 }), tache("b", { coutEstimeUsd: 8 })], { budget: { usd: 10, lancements: 1 } }));
    const f = !r.ok ? r.fautes.join(" ") : "";
    expect(f).toMatch(/Budget dépassé : 16\.00 \$ estimés pour 10\.00 \$/);
    expect(f).toMatch(/2 tâches pour 1 lancements/);
  });

  it("signale (sans refuser) les tâches non ordonnées qui se recouvrent : périmètre, ressource, migrations", () => {
    const r = lu(plan([
      tache("a", { perimetre: ["src/lib/finance/**"] }), tache("b", { perimetre: ["src/lib/finance/tva.ts"] }),
      tache("c", { perimetre: ["src/lib/x/**"], ressources: ["CONTRAT"] }), tache("d", { perimetre: ["src/lib/y/**"], ressources: ["CONTRAT"] }),
      tache("e", { migrations: true, perimetre: ["src/lib/e1/**"] }), tache("f", { migrations: true, perimetre: ["src/lib/f1/**"], dependances: ["e"] }),
    ]));
    expect(r.conflits.map((c) => `${c.a}-${c.b}`)).toEqual(["a-b", "c-d"]);
    expect(r.conflits[1]!.motif).toMatch(/CONTRAT/);
  });

  it("regroupe une chaîne de PETITES tâches liées en une seule session (le parallélisme n'en vaut pas le coût)", () => {
    const t = (cle: string, o: Partial<TacheProgramme>): TacheProgramme => ({ ...tache(cle), ressources: [], dependances: [], migrations: false, taille: "M", ...o });
    const r = regrouperPetitesTaches([t("a", { taille: "S" }), t("b", { taille: "S", dependances: ["a"] }), t("c", { dependances: ["b"] }), t("d", {})]);
    expect(r.regroupees).toEqual([["a", "b"]]);
    expect(r.taches.map((x) => x.cle)).toEqual(["a", "c", "d"]);
    expect(r.taches.find((x) => x.cle === "c")!.dependances).toEqual(["a"]);
    expect(r.taches[0]!.perimetre).toEqual(["src/lib/a/**", "src/lib/b/**"]);
  });
});

describe("ressources partagées nommées", () => {
  it("se déduisent des fichiers et des globs ; un module est une ressource", () => {
    expect(ressourcesDuFichier("prisma/migrations/2027_x/migration.sql")).toEqual(["SCHEMA"]);
    expect(ressourcesDuFichier("src/lib/actions/contrat.genere.json")).toEqual(["CONTRAT"]);
    expect(ressourcesDuFichier("package-lock.json")).toEqual(["DEPENDANCES"]);
    expect(ressourcesDuFichier("src/modules/finance/api.ts")).toEqual(["MODULE:finance"]);
    expect(ressourcesDeTache({ perimetre: ["prisma/**", "src/modules/rh/**"] })).toEqual(["MODULE:rh", "SCHEMA"]);
  });

  it("VÉRIFIÉES au diff : toucher le schéma ou le lockfile sans les réserver est une faute", () => {
    expect(ressourcesHorsReservation(["src/lib/x/a.ts", "prisma/schema.prisma", "package.json"], ["MODULE:x"])).toEqual(["DEPENDANCES", "SCHEMA"]);
    expect(ressourcesHorsReservation(["prisma/schema.prisma"], ["SCHEMA"])).toEqual([]);
  });

  it("un conflit limité aux fichiers générés et au lockfile a sa recette ; un autre n'en a pas", () => {
    expect(recetteDeRegeneration(["package-lock.json", "src/lib/actions/contrat.genere.json"])).toEqual(["npm install --package-lock-only", "npm run actions:contrat"]);
    expect(recetteDeRegeneration(["src/lib/x.ts"])).toBeNull();
  });
});

describe("ordonnanceur (pur)", () => {
  const p = (taches: TacheProgramme[], concurrence = 3) => ({ taches, concurrence });
  const t = (cle: string, o: Partial<TacheProgramme> = {}): TacheProgramme => ({ ...tache(cle), ressources: [], dependances: [], migrations: false, taille: "M", ...o });
  const large = { lancementsRestants: 99, usdRestant: 999 };

  it("trois tâches indépendantes partent ENSEMBLE", () => {
    expect(ordonnancer(p([t("a"), t("b"), t("c")]), {}, large).lancer).toEqual(["a", "b", "c"]);
  });

  it("deux tâches qui se recouvrent sont SÉRIALISÉES : la seconde attend l'INTÉGRATION de la première", () => {
    const taches = [t("a", { perimetre: ["src/lib/finance/**"] }), t("b", { perimetre: ["src/lib/finance/tva.ts"] })];
    const d1 = ordonnancer(p(taches), {}, large);
    expect(d1.lancer).toEqual(["a"]);
    expect(d1.attentes.b).toMatch(/sérialisée après « a »/);
    for (const e of ["LANCEE", "EN_FILE", "EN_INTEGRATION", "RETOUR"] as EtatTache[]) expect(ordonnancer(p(taches), { a: e }, large).lancer).toEqual([]);
    expect(ordonnancer(p(taches), { a: "INTEGREE" }, large).lancer).toEqual(["b"]);
  });

  it("une dépendance attend l'intégration, une dépendance morte rend la tâche orpheline (replanification)", () => {
    const taches = [t("a"), t("b", { dependances: ["a"] })];
    expect(ordonnancer(p(taches), { a: "EN_FILE" }, large).attentes.b).toMatch(/attend l'intégration de « a »/);
    const d = ordonnancer(p(taches), { a: "ECHEC" }, large);
    expect(d.orphelines).toEqual(["b"]);
    expect(d.fin).toBe("BLOQUE");
  });

  it("concurrence, lancements et dollars bornent les départs ; fini quand tout est intégré", () => {
    expect(ordonnancer(p([t("a"), t("b"), t("c")], 2), {}, large).lancer).toEqual(["a", "b"]);
    expect(ordonnancer(p([t("a"), t("b")]), {}, { lancementsRestants: 1, usdRestant: 99 }).attentes.b).toBe("plafond de lancements atteint");
    expect(ordonnancer(p([t("a", { coutEstimeUsd: 5 })]), {}, { lancementsRestants: 9, usdRestant: 2 }).lancer).toEqual([]);
    expect(ordonnancer(p([t("a"), t("b")]), { a: "INTEGREE", b: "INTEGREE" }, large).fin).toBe("COMPLETED");
  });
});

describe("MiMo planificateur — sortie validée, second essai, Sol en recours", () => {
  const bon = JSON.stringify(plan([tache("a"), tache("b")]));
  const cerveau = (reponses: Record<string, string[]>, dispo = { mimo: true, terra: true, sol: true }) => {
    const appels: { niveau: string; texte: string }[] = [];
    const c: CerveauChantier = {
      disponibles: () => dispo,
      executer: async (niveau, d) => { appels.push({ niveau, texte: d.texte }); return { ok: true, texte: reponses[niveau]!.shift() ?? "", coutUsd: 0.002, modele: niveau }; },
    };
    return { c, appels };
  };
  const demande = { texte: "Ajoute deux routes", depot: { proprietaire: "aminedjm", nom: "amd-internal-os" }, cible: "main" };

  it("extrait l'objet JSON d'une réponse bavarde", () => {
    expect(extraireJson("voici :\n```json\n{\"a\": 1}\n```")).toEqual({ a: 1 });
    expect(extraireJson("rien")).toBeNull();
  });

  it("MiMo au premier essai : plan validé", async () => {
    const { c, appels } = cerveau({ MIMO: [`Plan : ${bon}`] });
    const r = await planifier(demande, { cerveau: c, missionId: "m", userId: "u" });
    expect(r.lecture.ok).toBe(true);
    expect(r.par).toBe("MIMO");
    expect(appels).toHaveLength(1);
  });

  it("plan de MiMo refusé (cycle) → second essai AVEC les fautes → toujours refusé → Sol, qui réussit", async () => {
    const cyclique = JSON.stringify(plan([tache("a", { dependances: ["b"] }), tache("b", { dependances: ["a"] })]));
    const { c, appels } = cerveau({ MIMO: [cyclique, "pas du json"], SOL: [bon] });
    const r = await planifier(demande, { cerveau: c, missionId: "m", userId: "u" });
    expect(r.lecture.ok).toBe(true);
    expect(r.par).toBe("SOL");
    expect(appels.map((a) => a.niveau)).toEqual(["MIMO", "MIMO", "SOL"]);
    expect(appels[1]!.texte).toMatch(/REFUSÉ par le validateur[\s\S]*Cycle de dépendances/);
    expect(r.coutUsd).toBeCloseTo(0.006);
  });

  it("le dépôt et la cible sont ceux de la DEMANDE, jamais ceux que le modèle invente", async () => {
    const { c } = cerveau({ MIMO: [JSON.stringify(plan([tache("a")], { depot: { proprietaire: "autre", nom: "x" }, cible: "prod" }))] });
    const r = await planifier(demande, { cerveau: c, missionId: "m", userId: "u" });
    expect(r.lecture.ok && r.lecture.plan.depot).toEqual(demande.depot);
    expect(r.lecture.ok && r.lecture.plan.cible).toBe("main");
  });

  it("aucun planificateur : refus dit", async () => {
    const { c } = cerveau({}, { mimo: false, terra: false, sol: false });
    const r = await planifier(demande, { cerveau: c, missionId: "m", userId: "u" });
    expect(r.lecture.ok).toBe(false);
  });

  it("conflitsDeclares ignore les paires ordonnées par une dépendance", () => {
    const t = (cle: string, o: Partial<TacheProgramme> = {}): TacheProgramme => ({ ...tache(cle), ressources: [], dependances: [], migrations: false, taille: "M", ...o });
    expect(conflitsDeclares([t("a", { perimetre: ["src/**"] }), t("b", { perimetre: ["src/x/**"], dependances: ["a"] })])).toEqual([]);
  });
});
