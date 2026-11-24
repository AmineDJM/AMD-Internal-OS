import { describe, expect, it } from "vitest";
import { TAUX_TVA_ADMIS } from "@/lib/artifact/factory/commercial";
import {
  bornesDeLaPeriode, calculerTvaDuMois, champHt, champTva, CHAMP_TVA_AUTRES, CHAMP_TVA_ENVOYEE, estPeriodeTva, lireSaisieTva,
  lireTvaDeLaPiece, periodeDeLaFacture, raisonIncomplete, refusSaisieTva, saisieDesTotaux, TAUX_TVA, totauxDeLaSaisie, tvaAPreremplir,
  valeursDuFormulaire, type FacturePourTva,
} from "./tva";

const fd = (champs: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

const facture = (x: Partial<FacturePourTva> & { id: string }): FacturePourTva => ({
  reference: null, titre: x.id, avoir: false, direction: "OUT", montant: 119_000, dateEmission: new Date("2026-11-10T00:00:00Z"),
  tva: { sens: null, lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000 }], autresTaxes: 0, montantTtc: 119_000 },
  ...x,
});

describe("les taux de TVA — une seule table", () => {
  it("la table du calcul et celle de la fabrique disent les mêmes taux (pour cent ↔ fraction)", () => {
    expect(TAUX_TVA.map((t) => t.taux / 100).sort()).toEqual([...TAUX_TVA_ADMIS].sort());
  });
});

describe("cohérence HT / TVA / TTC d'une saisie", () => {
  it("HT + TVA = TTC, par taux : acceptée", () => {
    expect(refusSaisieTva({ lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000 }, { taux: 9, baseHt: 10_000, tva: 900 }], autresTaxes: 0, ttc: 129_900 })).toBeNull();
  });
  it("un timbre se saisit à part : HT + TVA + timbre = TTC", () => {
    expect(refusSaisieTva({ lignes: [{ taux: 19, baseHt: 1_000, tva: 190 }], autresTaxes: 11.9, ttc: 1_201.9 })).toBeNull();
  });
  it("TTC qui ne fait pas HT + TVA : refusé, le remède dit", () => {
    expect(refusSaisieTva({ lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000 }], autresTaxes: 0, ttc: 120_000 }))
      .toMatch(/HT \+ TVA = 119.000,00.DZD, mais le TTC de la facture est 120.000,00.DZD\. Corrigez/);
  });
  it("une TVA qui n'est pas base × taux (au-delà de 1 DZD) : refusée ; un arrondi de ligne passe", () => {
    expect(refusSaisieTva({ lignes: [{ taux: 19, baseHt: 100_000, tva: 18_000 }], autresTaxes: 0, ttc: 118_000 })).toMatch(/TVA à 19 % incohérente/);
    expect(refusSaisieTva({ lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000.4 }], autresTaxes: 0, ttc: 119_000.4 })).toBeNull();
  });
  it("taux inconnu, base à 0 % qui porte de la TVA, taux en double : refusés", () => {
    expect(refusSaisieTva({ lignes: [{ taux: 7, baseHt: 100, tva: 7 }], autresTaxes: 0, ttc: 107 })).toMatch(/inconnu/);
    expect(refusSaisieTva({ lignes: [{ taux: 0, baseHt: 100, tva: 1 }], autresTaxes: 0, ttc: 101 })).toMatch(/base à 0 %/);
    expect(refusSaisieTva({ lignes: [{ taux: 9, baseHt: 100, tva: 9 }, { taux: 9, baseHt: 100, tva: 9 }], autresTaxes: 0, ttc: 218 })).toMatch(/deux fois/);
  });
});

describe("lire la TVA d'un formulaire", () => {
  it("base sans TVA : la TVA est calculée ; champs vides : rien de saisi, mais « envoyée » (une modification les efface)", () => {
    const r = lireSaisieTva(fd({ [champHt(19)]: "100000", [champTva(19)]: "", [champHt(0)]: "5000" }), 124_000);
    expect(r).toEqual({ ok: true, envoyee: true, lue: false, saisie: { lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000 }, { taux: 0, baseHt: 5_000, tva: 0 }], autresTaxes: 0, ttc: 124_000 } });
    expect(lireSaisieTva(fd({ [CHAMP_TVA_ENVOYEE]: "1", [champHt(19)]: "" }), 1_000)).toEqual({ ok: true, envoyee: true, saisie: null, lue: false });
    expect(lireSaisieTva(fd({}), 1_000)).toEqual({ ok: true, envoyee: false, saisie: null, lue: false });
  });
  it("une TVA sans base, un nombre illisible, une TVA sans TTC : refusés", () => {
    expect(lireSaisieTva(fd({ [champTva(19)]: "190" }), 1_190)).toMatchObject({ ok: false, error: expect.stringMatching(/sans sa base HT/) });
    expect(lireSaisieTva(fd({ [champHt(19)]: "abc" }), 1_190)).toMatchObject({ ok: false, error: expect.stringMatching(/illisible/) });
    expect(lireSaisieTva(fd({ [champHt(19)]: "1000" }), null)).toMatchObject({ ok: false, error: expect.stringMatching(/montant TTC/) });
    expect(lireSaisieTva(fd({ [CHAMP_TVA_AUTRES]: "10" }), 10)).toMatchObject({ ok: false });
  });
  it("une pièce qui n'est ni facture ni avoir ignore les champs ; une facture sans date d'émission est refusée", () => {
    expect(lireTvaDeLaPiece(fd({ [champHt(19)]: "100" }), { kind: "CONTRACT", ttc: 119, dateEmission: null })).toMatchObject({ ok: true, saisie: null });
    expect(lireTvaDeLaPiece(fd({ [champHt(19)]: "100" }), { kind: "INVOICE", ttc: 119, dateEmission: null })).toMatchObject({ ok: false, error: expect.stringMatching(/date d'émission/) });
  });
  it("les valeurs rouvrent le formulaire sur la saisie", () => {
    expect(valeursDuFormulaire({ lignes: [{ taux: 19, baseHt: 100, tva: 19 }, { taux: 0, baseHt: 5, tva: 0 }], autresTaxes: 2 }))
      .toEqual({ tvaHt_19: "100", tvaMontant_19: "19", tvaHt_0: "5", tvaAutres: "2" });
  });
});

describe("la TVA d'une facture de vente émise par la fabrique", () => {
  it("ses totaux par taux (fraction) deviennent une saisie cohérente, timbre et taxes hors TVA", () => {
    const s = saisieDesTotaux({ tva: [{ taux: 0.09, base: 38_700, montant: 3_483 }], totalTaxes: 774, timbre: 0, totalTtc: 42_957 });
    expect(s).toEqual({ lignes: [{ taux: 9, baseHt: 38_700, tva: 3_483 }], autresTaxes: 774, ttc: 42_957 });
    expect(refusSaisieTva(s)).toBeNull();
    expect(totauxDeLaSaisie(s)).toEqual({ ht: 38_700, tva: 3_483 });
  });
});

describe("la période de TVA", () => {
  it("date d'émission au mois d'Alger ; bornes [1er 00:00 Alger, 1er du mois suivant[", () => {
    expect(periodeDeLaFacture(new Date("2026-11-30T00:00:00Z"))).toBe("2026-11");
    // 31/10 à 23h30 UTC = 1er novembre 00h30 à Alger.
    expect(periodeDeLaFacture(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11");
    expect(bornesDeLaPeriode("2026-12")).toEqual({ debut: new Date("2026-11-30T23:00:00Z"), fin: new Date("2026-12-31T23:00:00Z") });
    expect(estPeriodeTva("2026-11")).toBe(true);
    expect(estPeriodeTva("2026-T4")).toBe(false);
  });
});

describe("la TVA du mois — collectée − déductible", () => {
  it("somme par taux et par sens ; à payer = collectée − déductible", () => {
    const r = calculerTvaDuMois("2026-11", [
      facture({ id: "emise", direction: "IN", montant: 129_900, tva: { sens: null, lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000 }, { taux: 9, baseHt: 10_000, tva: 900 }], autresTaxes: 0, montantTtc: 129_900 } }),
      facture({ id: "recue" }),
      facture({ id: "recue-9", montant: 10_900, tva: { sens: null, lignes: [{ taux: 9, baseHt: 10_000, tva: 900 }], autresTaxes: 0, montantTtc: 10_900 } }),
    ]);
    expect({ collectee: r.collectee, deductible: r.deductible, aPayer: r.aPayer, credit: r.credit, comptees: r.facturesComptees })
      .toEqual({ collectee: 19_900, deductible: 19_900, aPayer: 0, credit: 0, comptees: 3 });
    expect(r.detailParTaux).toEqual([
      { taux: 19, collectee: { base: 100_000, tva: 19_000 }, deductible: { base: 100_000, tva: 19_000 } },
      { taux: 9, collectee: { base: 10_000, tva: 900 }, deductible: { base: 10_000, tva: 900 } },
    ]);
  });
  it("plus de déductible que de collectée : un CRÉDIT de TVA, et la G50 propose 0 à payer", () => {
    const r = calculerTvaDuMois("2026-11", [facture({ id: "recue" })]);
    expect({ aPayer: r.aPayer, credit: r.credit }).toEqual({ aPayer: -19_000, credit: 19_000 });
    expect(tvaAPreremplir(r)).toBe(0);
  });
  it("un avoir retranche sa TVA du sens de sa facture", () => {
    const r = calculerTvaDuMois("2026-11", [
      facture({ id: "f", direction: "IN" }),
      facture({ id: "av", avoir: true, direction: "IN", montant: 11_900, tva: { sens: null, lignes: [{ taux: 19, baseHt: 10_000, tva: 1_900 }], autresTaxes: 0, montantTtc: 11_900 } }),
    ]);
    expect(r.collectee).toBe(17_100);
    expect(tvaAPreremplir(r)).toBe(17_100);
  });
  it("le sens enregistré sert à défaut de direction ; sans l'un ni l'autre, la facture est à compléter", () => {
    const r = calculerTvaDuMois("2026-11", [
      facture({ id: "promo", direction: null, tva: { sens: "DEDUCTIBLE", lignes: [{ taux: 19, baseHt: 100_000, tva: 19_000 }], autresTaxes: 0, montantTtc: 119_000 } }),
      facture({ id: "muette", direction: null }),
    ]);
    expect(r.deductible).toBe(19_000);
    expect(r.facturesIncompletes.map((f) => [f.id, f.raison])).toEqual([["muette", "SENS_INCONNU"]]);
  });
  it("rien n'est inventé : TVA non renseignée, date manquante, TTC modifié depuis la saisie — listées, jamais comptées", () => {
    expect(raisonIncomplete(facture({ id: "a", tva: null }))).toBe("TVA_NON_RENSEIGNEE");
    expect(raisonIncomplete(facture({ id: "b", dateEmission: null }))).toBe("DATE_MANQUANTE");
    expect(raisonIncomplete(facture({ id: "c", montant: 120_000 }))).toBe("TTC_MODIFIE");
    const r = calculerTvaDuMois("2026-11", [facture({ id: "ok", direction: "IN" }), facture({ id: "a", tva: null })]);
    expect(r.collectee).toBe(19_000);
    expect(r.facturesIncompletes).toHaveLength(1);
    // Une pièce à compléter : la G50 ne reçoit pas de chiffre partiel.
    expect(tvaAPreremplir(r)).toBeNull();
    expect(tvaAPreremplir(calculerTvaDuMois("2026-11", []))).toBeNull();
  });
});
