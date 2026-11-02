import { describe, expect, it } from "vitest";
import { consolider, lireTableau, listeNumeros, phraseReconciliation, reconcilier, type LigneTableau, type Rangee } from "./tableau";
import { rangeesDesGlyphes } from "./positions";

/**
 * LE TABLEAU PAR SES POSITIONS (lot B1, décision 0049) — en-têtes répétés, reports, suite de désignation,
 * blocs répétés, numéros manquants, et la phrase qui NOMME les lignes douteuses.
 */
let y = 0;
const R = (page: number, ...cells: [string, number][]): Rangee => {
  y += 14;
  return { page, y, taille: 8, cellules: cells.map(([texte, x0]) => ({ texte, x0, x1: x0 + texte.length * 4 })) };
};
const ENTETE = (p: number) => R(p, ["N°", 40], ["Désignation", 70], ["Qté", 300], ["P.U. HT", 360], ["Montant HT", 450]);
const L = (p: number, n: number, des: string, q: string, pu: string, m: string) => R(p, [String(n), 44], [des, 70], [q, 305], [pu, 365], [m, 455]);

describe("lireTableau", () => {
  it("lit les lignes numérotées sous l'en-tête, ignore l'en-tête répété, les titres, les reports ; recolle la suite d'une désignation", () => {
    y = 0;
    const rs: Rangee[] = [
      ENTETE(1), R(1, ["BLOC 1 — CRÉATION", 70]),
      L(1, 1, "Conception ADV", "1", "145 000,00", "145 000,00"),
      L(1, 2, "Polo piqué brodé,", "120", "1 450,00", "174 000,00"),
      { page: 1, y: y + 9, taille: 8, cellules: [{ texte: "tailles S à XXL", x0: 70, x1: 130 }] },
      R(1, ["À reporter", 70], ["319 000,00", 455]),
      ENTETE(2), R(2, ["Report", 70], ["319 000,00", 455]),
      L(2, 3, "Fiche posologique", "500", "225,00", "112 500,00"),
      R(2, ["Total HT", 300], ["431 500,00", 455]),
      R(2, ["TVA 19 %", 300], ["81 985,00", 455]),
    ];
    const t = lireTableau(rs);
    expect(t.enTete).toBe(true);
    expect(t.lignes.map((l) => [l.numero, l.designation, l.quantite, l.prixUnitaire, l.montant])).toEqual([
      [1, "Conception ADV", 1, 145_000, 145_000],
      [2, "Polo piqué brodé, tailles S à XXL", 120, 1_450, 174_000],
      [3, "Fiche posologique", 500, 225, 112_500],
    ]);
    expect(t.totalHt).toBe(431_500);
    expect(t.trous).toEqual([]);
    expect(reconcilier(t, t.totalHt).juste).toBe(true);
  });

  it("une page imprimée deux fois : les lignes identiques ne comptent qu'une fois, et c'est compté", () => {
    y = 0;
    const page = (p: number) => [ENTETE(p), L(p, 1, "Stylo", "100", "45,00", "4 500,00"), L(p, 2, "Mug", "10", "300,00", "3 000,00")];
    const t = lireTableau([...page(1), ...page(2)]);
    expect(t.lignes).toHaveLength(2);
    expect(t.doublonsRetires).toBe(2);
  });

  it("« 5.000 » (milliers à points) est une quantité de 5 000, pas une lecture ambiguë", () => {
    y = 0;
    const t = lireTableau([ENTETE(1), L(1, 1, "Flyers A5", "5.000", "9,00", "45.000,00")]);
    expect(t.lignes[0]).toMatchObject({ quantite: 5_000, prixUnitaire: 9, montant: 45_000, designation: "Flyers A5" });
  });
});

describe("consolider et reconcilier — nommer ce qui ne va pas", () => {
  const l = (numero: number, montant: number, designation = `Ligne ${numero}`): LigneTableau =>
    ({ numero, designation, reference: null, quantite: 1, prixUnitaire: montant, montant, page: 1, doutes: [] });

  it("les numéros manquants sont dits en plages ; un même numéro à deux contenus reste douteux", () => {
    const c = consolider([l(1, 10), l(2, 20), l(3, 30), l(3, 31, "Autre"), l(9, 90), l(10, 100), l(14, 140)]);
    expect(c.trous).toEqual([4, 5, 6, 7, 8, 11, 12, 13]);
    expect(listeNumeros(c.trous)).toBe("4 à 8 et 11 à 13");
    expect(c.lignes.find((x) => x.designation === "Autre")?.doutes[0]).toMatch(/deux fois/);
  });

  it("la phrase de la carte : l'écart en UNE phrase, les lignes non lues et douteuses NOMMÉES", () => {
    const lignes = [l(1, 100_000), l(2, 99_000, "Banner")];
    const r = reconcilier({ lignes, trous: [3, 4] }, 100_000);
    expect(r.juste).toBe(false);
    const p = phraseReconciliation(r, (n) => `${n} DZD`)!;
    expect(p).toMatch(/les lignes font 199000 DZD HT, le devis imprime 100000 DZD/i);
    expect(p).toMatch(/lignes 3, 4 non lues/);
    expect(p).toMatch(/ligne 2 \(son montant \(99000\) est exactement l'écart/);
    expect(p.split(". ").length).toBe(1);
  });

  it("rien à dire quand tout se tient", () => {
    expect(phraseReconciliation(reconcilier({ lignes: [l(1, 50)], trous: [] }, 50), String)).toBeNull();
  });
});

describe("rangeesDesGlyphes — des caractères positionnés aux cellules", () => {
  it("« 145 000,00 » reste une cellule ; l'écart d'une colonne en commence une autre", () => {
    const g = (s: string, x: number, yy = 100) => [...s].map((c, i) => ({ c, x0: x + i * 4.4, x1: x + i * 4.4 + 4.4, y: yy, taille: 8 }));
    const rs = rangeesDesGlyphes(1, [...g("2", 44), ...g("Conception ADV", 70), ...g("145 000,00", 360), ...g("145 000,00", 450)]);
    expect(rs).toHaveLength(1);
    expect(rs[0].cellules.map((c) => c.texte)).toEqual(["2", "Conception ADV", "145 000,00", "145 000,00"]);
  });
});
