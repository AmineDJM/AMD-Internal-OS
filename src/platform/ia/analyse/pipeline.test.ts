import { describe, expect, it } from "vitest";
import { appliquerEtapes, filtreDe, mesureDe, OPS_PIPELINE, MODE_EMPLOI_PIPELINE } from "./pipeline";

/**
 * LE PIPELINE — la spec d'un modèle compilée en opérations fermées. Ce qu'on vérifie : la
 * chaîne complète tourne dans l'ordre, une étape invalide est REFUSÉE ET DITE sans arrêter le
 * lot, une colonne absente est nommée avec les colonnes réelles, et les sorties qui ne sont pas
 * des lignes (tendance, scénario, profil) arrivent dans `resultats`.
 */
const depenses = [
  { societe: "Adventum", categorie: "Marketing", date: "2026-01-10", montant: 120_000 },
  { societe: "Adventum", categorie: "IT", date: "2026-01-22", montant: 40_000 },
  { societe: "Pharmalliance", categorie: "Marketing", date: "2026-02-05", montant: 80_000 },
  { societe: "Adventum", categorie: "Marketing", date: "2026-03-14", montant: 150_000 },
  { societe: "Pharmalliance", categorie: "IT", date: "2026-03-28", montant: 20_000 },
  { societe: "Adventum", categorie: "IT", date: "2026-04-02", montant: 60_000 },
];

describe("compilation des champs", () => {
  it("une mesure se lit en objet ou en chaîne ; un agrégat inconnu est refusé", () => {
    expect(mesureDe("montant")).toEqual({ colonne: "montant", agregat: "sum" });
    expect(mesureDe({ colonne: "montant", agregat: "avg", alias: "moy" })).toEqual({ colonne: "montant", agregat: "avg", alias: "moy" });
    expect(mesureDe({ agregat: "count" }, "societe")).toEqual({ colonne: "societe", agregat: "count" });
    expect(mesureDe({ colonne: "montant", agregat: "variance" })).toBeNull();
    expect(mesureDe({ agregat: "sum" })).toBeNull();
  });
  it("un filtre exige une colonne et un opérateur connu", () => {
    expect(filtreDe({ colonne: "montant", op: ">", valeur: 50_000 })).toEqual({ colonne: "montant", op: ">", valeur: 50_000 });
    expect(filtreDe({ colonne: "montant", op: "like", valeur: "x" })).toBeNull();
    expect(filtreDe({ op: "=" })).toBeNull();
  });
  it("le mode d'emploi nomme chaque opération exposée", () => {
    for (const op of OPS_PIPELINE) expect(MODE_EMPLOI_PIPELINE).toContain(op);
  });
});

describe("appliquer les étapes", () => {
  it("filtrer → regrouper → trier → limiter : la chaîne complète, journal à l'appui", () => {
    const r = appliquerEtapes(depenses, [
      { op: "filtrer", filtres: [{ colonne: "montant", op: ">=", valeur: 40_000 }] },
      { op: "regrouper", par: ["societe"], mesures: [{ colonne: "montant", agregat: "sum", alias: "total" }, { agregat: "count", alias: "n" }] },
      { op: "trier", colonne: "total", sens: "desc" },
      { op: "limiter", n: 1 },
    ]);
    expect(r.erreurs).toEqual([]);
    expect(r.journal.map((j) => [j.op, j.avant, j.apres])).toEqual([["filtrer", 6, 5], ["regrouper", 5, 2], ["trier", 2, 2], ["limiter", 2, 1]]);
    expect(r.lignes).toEqual([{ societe: "Adventum", total: 370_000, n: 4 }]);
  });
  it("une opération inconnue est refusée et dite ; les autres tournent quand même", () => {
    const r = appliquerEtapes(depenses, [{ op: "pivoter_magique" }, { op: "regrouper", par: ["categorie"] }]);
    expect(r.erreurs).toHaveLength(1);
    expect(r.erreurs[0]).toMatch(/opération inconnue/);
    expect(r.erreurs[0]).toContain("regrouper");
    expect(r.lignes.map((l) => l.categorie).sort()).toEqual(["IT", "Marketing"]);
    // Sans mesure : un comptage par défaut, nommé « n ».
    expect(r.lignes.find((l) => l.categorie === "Marketing")!.n).toBe(3);
  });
  it("une colonne absente est refusée EN NOMMANT les colonnes réelles", () => {
    const r = appliquerEtapes(depenses, [{ op: "trier", colonne: "montnat" }]);
    expect(r.erreurs[0]).toMatch(/« montnat » absente/);
    expect(r.erreurs[0]).toContain("montant");
    expect(r.lignes).toHaveLength(6);
  });
  it("série mensuelle → croissance → tendance : les mois vides comblés, la tendance dans resultats", () => {
    const r = appliquerEtapes(depenses, [
      { op: "serie", colonneDate: "date", mesure: { colonne: "montant", agregat: "sum" }, pas: "mois" },
      { op: "croissance", colonne: "valeur" },
      { op: "tendance", colonne: "valeur" },
    ]);
    expect(r.erreurs).toEqual([]);
    expect(r.lignes.map((l) => l.periode)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(r.lignes.map((l) => l.valeur)).toEqual([160_000, 80_000, 170_000, 60_000]);
    expect(r.lignes[1].croissance_valeur).toBe(-50);
    expect(r.resultats.tendance_valeur).toMatchObject({ n: 4 });
  });
  it("croiser fait un tableau croisé ; colonnes garde ce qu'on demande", () => {
    const r = appliquerEtapes(depenses, [
      { op: "croiser", ligne: "societe", colonne: "categorie", mesure: { colonne: "montant", agregat: "sum" } },
      { op: "colonnes", garder: ["societe", "Marketing"] },
    ]);
    expect(r.erreurs).toEqual([]);
    expect(r.lignes.find((l) => l.societe === "Adventum")).toEqual({ societe: "Adventum", Marketing: 270_000 });
  });
  it("anomalies sur moins de huit valeurs : aucune, et la note le dit", () => {
    const r = appliquerEtapes(depenses, [{ op: "anomalies", colonne: "montant" }]);
    expect(r.lignes).toEqual([]);
    expect(r.resultats.anomalies_montant).toMatchObject({ n: 0, note: expect.stringContaining("huit") });
  });
  it("scénario et décrire remplissent resultats sans toucher aux lignes", () => {
    const r = appliquerEtapes(depenses, [
      { op: "scenario", variations: [{ colonne: "montant", pourcent: -10 }], mesure: { colonne: "montant", agregat: "sum" } },
      { op: "decrire" },
    ]);
    expect(r.lignes).toHaveLength(6);
    expect(r.resultats.scenario).toMatchObject({ base: 470_000, scenario: 423_000, hypotheses: ["montant -10 %"] });
    expect((r.resultats.profil as { lignes: number }).lignes).toBe(6);
  });
  it("cohortes : rétention par période depuis la première apparition", () => {
    const r = appliquerEtapes(depenses, [{ op: "cohortes", colonneEntite: "societe", colonneDate: "date", pas: "mois" }]);
    expect(r.erreurs).toEqual([]);
    expect(r.lignes[0]).toMatchObject({ cohorte: "2026-01", taille: 1, "p+0": 100 });
    expect(r.resultats.cohortes).toMatchObject({ pas: "mois" });
  });
  it("plus de vingt étapes : les suivantes sont ignorées et c'est dit", () => {
    const r = appliquerEtapes(depenses, Array.from({ length: 25 }, () => ({ op: "limiter", n: 100 })));
    expect(r.journal).toHaveLength(20);
    expect(r.erreurs[0]).toMatch(/25 étapes/);
  });
});
