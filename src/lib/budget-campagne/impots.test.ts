import { describe, expect, it } from "vitest";
import { TAUX_TVA_ADMIS } from "@/lib/artifact/factory/commercial";
import {
  CLES_IMPOTS, ENVELOPPE_IMPOTS_TAXES, PARAMETRES_IMPOTS_DEFAUT, TAUX_TVA_PCT, calculerPrevisions, calendrierEnTexte,
  lireCalendrierTexte, lireParametresImpots, montantPrevuDeLaLigne, natureDeLaDepense, repartirIbs, totalGroupe,
  tvaAReverserAvecReport, tvaContenueDansTtc, verifierCalendrierIbs, type ParametresImpots,
} from "./impots";

const P: ParametresImpots = { ...structuredClone(PARAMETRES_IMPOTS_DEFAUT), ibsParSociete: { B: 19 } };

describe("impôts & taxes — les clés et les taux", () => {
  it("les clés stables de l'enveloppe du lot impôts : TVA nette et IBS, rien d'autre", () => {
    expect(ENVELOPPE_IMPOTS_TAXES).toBe("IMPOTS_TAXES");
    expect([...CLES_IMPOTS]).toEqual(["TVA_NETTE", "IBS"]);
  });

  it("les taux de TVA admis sont ceux de la fabrique (en %)", () => {
    expect([...TAUX_TVA_PCT].sort()).toEqual(TAUX_TVA_ADMIS.map((t) => Math.round(t * 100)).sort());
  });

  it("les paramètres stockés se lisent ; l'illisible reprend le préréglage, marqué à confirmer", () => {
    expect(lireParametresImpots(null)).toEqual(PARAMETRES_IMPOTS_DEFAUT);
    expect(PARAMETRES_IMPOTS_DEFAUT.confirmesParCabinet).toBe(false);
    const p = lireParametresImpots({
      tvaParNature: { RECETTES: 0, DEPENSES: 7 }, ibsParSociete: { A: 19, B: "x" }, calendrierIbs: [{ mois: 12, pct: 50 }], confirmesParCabinet: true,
    });
    expect(p.tvaParNature.RECETTES).toBe(0);
    expect(p.tvaParNature.DEPENSES).toBe(19); // 7 % n'existe pas
    expect(p.ibsParSociete).toEqual({ A: 19 });
    expect(p.calendrierIbs).toEqual(PARAMETRES_IMPOTS_DEFAUT.calendrierIbs); // 50 % ≠ 100 %
    expect(p.confirmesParCabinet).toBe(true);
  });

  it("le calendrier : 100 % exigé, saisi en texte et relu", () => {
    expect(verifierCalendrierIbs(PARAMETRES_IMPOTS_DEFAUT.calendrierIbs).ok).toBe(true);
    expect(verifierCalendrierIbs([{ mois: 3, pct: 60, exerciceSuivant: false }]).ok).toBe(false);
    const texte = calendrierEnTexte(PARAMETRES_IMPOTS_DEFAUT.calendrierIbs);
    expect(texte).toBe("3:30, 6:30, 11:30, 5:10+");
    expect(lireCalendrierTexte(texte)).toEqual(PARAMETRES_IMPOTS_DEFAUT.calendrierIbs);
    expect(lireCalendrierTexte("mars")).toBeNull();
  });

  it("la nature d'une dépense : paie et recrutements = masse salariale, BV = versements à l'État", () => {
    expect(natureDeLaDepense({ source: "AUTO_PAIE", categoryKey: null })).toBe("MASSE_SALARIALE");
    expect(natureDeLaDepense({ source: "SAISIE", categoryKey: "MASSE_SALARIALE_FDV" })).toBe("MASSE_SALARIALE");
    expect(natureDeLaDepense({ source: "SAISIE", categoryKey: "MS_CNAS" })).toBe("MASSE_SALARIALE");
    expect(natureDeLaDepense({ source: "AUTO_BV", categoryKey: "BV_25" })).toBe("VERSEMENTS_ETAT");
    expect(natureDeLaDepense({ source: "SAISIE", categoryKey: null })).toBe("DEPENSES");
  });

  it("le montant prévu d'une dépense suit l'état de sa proposition", () => {
    const l = { propose: 100, ajuste: 80, decision: "AJUSTE" };
    expect(montantPrevuDeLaLigne("REFUSE", l)).toBe(0);
    expect(montantPrevuDeLaLigne("ACCEPTE_AVEC_AJUSTEMENTS", l)).toBe(80);
    expect(montantPrevuDeLaLigne("SOUMIS", l)).toBe(100);
  });
});

describe("impôts & taxes — TVA nette prévue (achats au montant du budget, TTC)", () => {
  it("la TVA d'un achat s'extrait du TTC au taux de la ligne : TTC × t / (100 + t), jamais 19 % du TTC", () => {
    expect(tvaContenueDansTtc(1190, 19)).toBe(190);
    expect(tvaContenueDansTtc(1090, 9)).toBe(90);
    expect(tvaContenueDansTtc(1000, 0)).toBe(0);
  });

  it("TVA collectée sur les ventes − TVA déductible sur les achats, par mois ; les achats comptent HT dans le résultat", () => {
    const [a] = calculerPrevisions({
      societes: ["A"], parametres: P, ajustements: [],
      recettes: [{ companyId: "A", mois: 1, montant: 1000, tvaPct: null }, { companyId: "A", mois: 2, montant: 1000, tvaPct: 9 }, { companyId: "A", mois: 3, montant: 1000, tvaPct: 0 }],
      depenses: [
        { companyId: "A", montant: 14280, nature: "DEPENSES", tvaPct: null }, // 1 190 TTC / mois à 19 %
        { companyId: "A", montant: 12000, nature: "MASSE_SALARIALE", tvaPct: null }, // 0 %
      ],
    });
    expect(a!.tvaCollectee.slice(0, 4)).toEqual([190, 90, 0, 0]);
    expect(a!.tvaDeductible[0]).toBe(190);
    expect(a!.depenses[0]).toBe(1000 + 1000);
    expect(a!.impots.TVA_NETTE[0]!.calcule).toBe(0);
    expect(a!.impots.TVA_NETTE[1]!.calcule).toBe(-100);
    expect(a!.impots.TVA_NETTE[3]!.calcule).toBe(-190); // un crédit
  });

  it("un crédit de TVA se reporte : on ne reverse que le positif", () => {
    expect(tvaAReverserAvecReport([-50, 30, 40, -10])).toEqual({ mois: [0, 0, 20, 0], creditFinal: 10 });
  });

  it("un ajustement remplace le calcul, qui reste à côté (l'écart se lit)", () => {
    const [a] = calculerPrevisions({
      societes: ["A"], parametres: P,
      recettes: [{ companyId: "A", mois: 1, montant: 1000, tvaPct: null }], depenses: [],
      ajustements: [{ companyId: "A", mois: 1, cle: "TVA_NETTE", montant: 150, calcule: 190 }],
    });
    expect(a!.impots.TVA_NETTE[0]).toEqual({ calcule: 190, retenu: 150, ajuste: true });
    expect(a!.tvaAReverser[0]).toBe(150);
  });
});

describe("impôts & taxes — IBS sur le résultat", () => {
  it("IBS = résultat avant impôt × taux de la société, en acomptes + solde sur l'exercice suivant", () => {
    const [a, b] = calculerPrevisions({
      societes: ["A", "B"], parametres: P, ajustements: [],
      recettes: [{ companyId: "A", mois: 1, montant: 1_000_000, tvaPct: 0 }, { companyId: "B", mois: 1, montant: 1_000_000, tvaPct: 0 }],
      depenses: [{ companyId: "A", montant: 600_000, nature: "DEPENSES", tvaPct: 0 }],
    });
    // A : 400 000 × 26 % = 104 000 → 30 % en mars, juin, novembre ; 10 % en mai N+1.
    expect(a!.totaux.resultatAvantImpot).toBe(400_000);
    expect(a!.totaux.ibs).toBe(104_000);
    expect(a!.impots.IBS[2]!.calcule).toBe(31_200);
    expect(a!.impots.IBS[12]!.calcule).toBe(10_400);
    expect(a!.totaux.resultatNet).toBe(296_000);
    // B : taux propre de 19 %.
    expect(b!.totaux.ibs).toBe(190_000);
  });

  it("pas d'IBS sur une perte ; le calendrier absorbe l'arrondi", () => {
    const [a] = calculerPrevisions({ societes: ["A"], parametres: P, ajustements: [], recettes: [], depenses: [{ companyId: "A", montant: 100, nature: "DEPENSES", tvaPct: 0 }] });
    expect(a!.totaux.ibs).toBe(0);
    const r = repartirIbs(100.01, [{ mois: 1, pct: 33.33, exerciceSuivant: false }, { mois: 2, pct: 33.33, exerciceSuivant: false }, { mois: 3, pct: 33.34, exerciceSuivant: false }]);
    expect(Math.round(r.reduce((x, y) => x + y, 0) * 100)).toBe(10001);
  });
});

describe("la masse salariale dans la synthèse : net + primes, IRG, CNAS — hors du volet Impôts & taxes", () => {
  it("les trois lignes du pôle s'additionnent en masse salariale, et le contrôle les confronte au coût employeur", () => {
    const [a, b] = calculerPrevisions({
      societes: ["A", "B"], parametres: P, ajustements: [], recettes: [],
      depenses: [
        { companyId: "A", montant: 1_200_000, nature: "MASSE_SALARIALE", tvaPct: null, categoryKey: "MASSE_SALARIALE" },
        { companyId: "A", montant: 240_000, nature: "MASSE_SALARIALE", tvaPct: null, categoryKey: "MS_IRG" },
        { companyId: "A", montant: 600_000, nature: "MASSE_SALARIALE", tvaPct: null, categoryKey: "MS_CNAS" },
      ],
      retenues: { A: { net: 100_000, irg: 20_000, cnas: 50_000, coutEmployeur: 170_000, salaries: 3 } },
    });
    expect(a!.masseSalariale).toEqual({ netEtPrimes: 1_200_000, irg: 240_000, cnas: 600_000, total: 2_040_000 });
    expect(a!.totaux.depenses).toBe(2_040_000); // IRG et CNAS sont DANS la masse salariale — comptés une fois
    expect(a!.controleMasseSalariale).toMatchObject({ reconstitue: 2_040_000, coutEmployeur: 2_040_000, boucle: true });
    expect(Object.keys(a!.impots)).toEqual(["TVA_NETTE", "IBS"]);
    expect(b!.controleMasseSalariale).toBeNull();
  });

  it("le profil d'une ligne place les primes au mois de leur versement", () => {
    const profil = [...Array.from({ length: 11 }, () => 100), 200]; // 13e mois en décembre
    const [a] = calculerPrevisions({ societes: ["A"], parametres: P, ajustements: [], recettes: [], depenses: [{ companyId: "A", montant: 1300, nature: "MASSE_SALARIALE", tvaPct: null, profil }] });
    expect(a!.depenses[0]).toBe(100);
    expect(a!.depenses[11]).toBe(200);
  });
});

describe("impôts & taxes — la synthèse", () => {
  it("ventes HT − achats HT = résultat avant impôt ; − IBS = net ; la TVA n'entre pas dans le résultat", () => {
    const ps = calculerPrevisions({
      societes: ["A", "B"], parametres: P, ajustements: [],
      recettes: [{ companyId: "A", mois: 1, montant: 1200, tvaPct: null }, { companyId: "B", mois: 6, montant: 600, tvaPct: null }],
      depenses: [{ companyId: "A", montant: 1428, nature: "DEPENSES", tvaPct: 19 }, { companyId: null, montant: 120, nature: "DEPENSES", tvaPct: 0 }],
    });
    expect(ps.map((p) => p.companyId)).toEqual(["A", "B", null]);
    const [a, b, horsSociete] = ps;
    expect(a!.resultatAvantImpot[0]).toBe(1100); // 1 200 − 100 HT
    expect(a!.totaux.resultatAvantImpot).toBe(0);
    expect(a!.totaux.resultatNet).toBe(0); // la TVA collectée (228) n'est pas un produit
    expect(b!.totaux.resultatNet).toBe(600 - 114); // B : IBS à 19 %
    expect(horsSociete!.totaux.ibs).toBe(0);
    const g = totalGroupe(ps);
    expect(g.totaux.recettesHT).toBe(1800);
    expect(g.totaux.depenses).toBe(1320);
    expect(g.totaux.resultatAvantImpot).toBe(480);
    expect(g.resultatNet.length).toBe(13);
    // L'enveloppe Impôts & taxes de l'année = TVA à reverser + IBS payé dans l'année.
    expect(b!.totaux.enveloppeImpotsTaxes).toBe(Math.round((b!.totaux.tvaAReverser + 114 * 0.9) * 100) / 100);
  });
});
