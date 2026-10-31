import { describe, expect, it } from "vitest";
import {
  anomalies, cohortes, croiser, croissance, cumul, decrire, filtrer, mediane, moyenneMobile, percentile, rang, regrouper, scenario, serie, tendance, trier,
  versDate, versNombre, OPERATIONS,
} from "./analyse";

/**
 * LES OPÉRATIONS D'ANALYSE — pures, fermées, et chacune vérifiée sur un cas qui a un sens
 * métier : des montants en DZD avec espaces fines, des mois vides, une valeur aberrante,
 * une rétention de cohorte, un scénario à +10 %.
 */
const ventes = [
  { societe: "Adventum", mois: "2026-01-15", montant: "1 250 000,50 DZD", produit: "A" },
  { societe: "Adventum", mois: "2026-01-20", montant: 750_000, produit: "B" },
  { societe: "Pharmalliance", mois: "2026-02-03", montant: 300_000, produit: "A" },
  { societe: "Adventum", mois: "2026-03-09", montant: 900_000, produit: "A" },
  { societe: "Pharmalliance", mois: "2026-03-30", montant: "n/a", produit: "B" },
];

describe("lecture des valeurs — nombres et dates à la française", () => {
  it("un montant avec espaces fines, virgule décimale et devise devient un nombre", () => {
    expect(versNombre("1 250 000,50 DZD")).toBe(1_250_000.5);
    expect(versNombre("12 345")).toBe(12_345);
    expect(versNombre("abc")).toBeNull();
    expect(versNombre("")).toBeNull();
  });
  it("une date ISO ou française est lue, le reste est null", () => {
    expect(versDate("2026-03-09")?.toISOString().slice(0, 10)).toBe("2026-03-09");
    expect(versDate("09/03/2026")?.toISOString().slice(0, 10)).toBe("2026-03-09");
    expect(versDate("hier")).toBeNull();
  });
  it("médiane et percentile", () => {
    expect(mediane([3, 1, 2])).toBe(2);
    expect(mediane([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(mediane([])).toBeNull();
  });
});

describe("décrire, regrouper, croiser, filtrer, trier", () => {
  it("le profil reconnaît les types et compte les distincts", () => {
    const p = decrire(ventes);
    expect(p.lignes).toBe(5);
    const parNom = Object.fromEntries(p.colonnes.map((c) => [c.nom, c]));
    expect(parNom.societe.type).toBe("texte");
    expect(parNom.societe.distincts).toBe(2);
    expect(parNom.mois.type).toBe("date");
    expect(parNom.montant.type).toBe("nombre");
  });
  it("regrouper somme les montants lisibles et DIT ceux qu'il a ignorés", () => {
    const r = regrouper(ventes, ["societe"], [{ colonne: "montant", agregat: "sum", alias: "total" }, { colonne: "montant", agregat: "count", alias: "n" }]);
    const adv = r.lignes.find((l) => l.societe === "Adventum")!;
    expect(adv.total).toBe(1_250_000.5 + 750_000 + 900_000);
    expect(adv.n).toBe(3);
    expect(r.ignores).toEqual([{ colonne: "montant", ignorees: 1, raison: "valeur non numérique" }]);
  });
  it("croiser fait un tableau croisé société × produit", () => {
    const r = croiser(ventes, "societe", "produit", { colonne: "montant", agregat: "sum" });
    expect(r.colonnes).toEqual(["A", "B"]);
    expect(r.lignes.find((l) => l.societe === "Adventum")!.A).toBe(1_250_000.5 + 900_000);
  });
  it("filtrer : comparaison numérique, contient, dans, vide", () => {
    expect(filtrer(ventes, [{ colonne: "montant", op: ">=", valeur: 900_000 }])).toHaveLength(2);
    expect(filtrer(ventes, [{ colonne: "societe", op: "contient", valeur: "pharma" }])).toHaveLength(2);
    expect(filtrer(ventes, [{ colonne: "produit", op: "dans", valeur: ["B"] }])).toHaveLength(2);
    expect(filtrer(ventes, [{ colonne: "mois", op: ">", valeur: "2026-02-01" }])).toHaveLength(3);
    expect(filtrer([{ a: null }, { a: 1 }], [{ colonne: "a", op: "vide" }])).toHaveLength(1);
  });
  it("trier : numérique quand c'est un nombre, sinon texte ; rang numérote", () => {
    expect(trier(ventes, "montant", "desc").map((l) => l.produit)[0]).toBe("A");
    expect(trier([{ n: "b" }, { n: "a" }], "n", "asc")[0].n).toBe("a");
    expect(rang(ventes, "montant")[0].rang).toBe(1);
  });
});

describe("séries temporelles", () => {
  it("la série mensuelle comble février (0 pour une somme) et signale les dates illisibles", () => {
    const r = serie([...ventes, { societe: "X", mois: "??", montant: 1 }], "mois", { colonne: "montant", agregat: "sum" }, "mois");
    expect(r.points.map((p) => p.periode)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(r.points[0].valeur).toBe(2_000_000.5);
    expect(r.ignores[0]).toMatchObject({ colonne: "mois", ignorees: 1 });
  });
  it("moyenne mobile, croissance (null sur base nulle), cumul, tendance (R² = 1 sur une droite)", () => {
    expect(moyenneMobile([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(croissance([100, 110, 0, 5])).toEqual([null, 10, -100, null]);
    expect(cumul([1, null, 2])).toEqual([1, null, 3]);
    const t = tendance([2, 4, 6, 8])!;
    expect(t.pente).toBeCloseTo(2);
    expect(t.r2).toBeCloseTo(1);
    expect(tendance([1, 2])).toBeNull();
  });
});

describe("anomalies, cohortes, scénarios", () => {
  it("moins de huit valeurs : rien ; un pic parmi dix : trouvé, avec son z", () => {
    expect(anomalies([{ v: 1 }, { v: 2 }, { v: 100 }], "v").lignes).toHaveLength(0);
    const lignes = [10, 11, 9, 10, 12, 10, 11, 9, 10, 500].map((v, i) => ({ i, v }));
    const r = anomalies(lignes, "v");
    expect(r.lignes.map((l) => l.i)).toEqual([9]);
    expect(Math.abs(r.lignes[0].z)).toBeGreaterThan(3.5);
    expect(r.mediane).toBe(10);
  });
  it("cohortes : rétention à 100 en p+0, puis la part présente", () => {
    const r = cohortes([
      { client: "a", d: "2026-01-02" }, { client: "b", d: "2026-01-09" }, { client: "a", d: "2026-02-02" }, { client: "c", d: "2026-02-10" },
    ], "client", "d", "mois");
    expect(r.periodes).toEqual(["2026-01", "2026-02"]);
    expect(r.cohortes[0]).toEqual({ cohorte: "2026-01", taille: 2, retention: [100, 50] });
  });
  it("scénario : +10 % sur les montants lisibles, hypothèses dites, base intacte", () => {
    const r = scenario(ventes, [{ colonne: "montant", pourcent: 10 }], { colonne: "montant", agregat: "sum" });
    expect(r.base).toBeCloseTo(3_200_000.5);
    expect(r.scenario).toBeCloseTo(3_200_000.5 * 1.1);
    expect(r.hypotheses).toEqual(["montant +10 %"]);
    expect(ventes[1].montant).toBe(750_000);
  });
  it("la surface exposée est fermée et nommée", () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual(["anomalies", "cohortes", "croiser", "croissance", "cumul", "decrire", "filtrer", "mediane", "moyenneMobile", "percentile", "rang", "regrouper", "scenario", "serie", "tendance", "trier"]);
  });
});
