import { describe, it, expect } from "vitest";
import { cleMois, dansLaPeriode, dateChoisie, dateDeLaDepense, engagementDuPoste, ordreEngage, surplusDuBc } from "./engage";

/**
 * L'ENGAGÉ ET LA DATE D'UNE DÉPENSE (Budget Marketing, Direction 10/2026) — les deux corrections de la vue d'ensemble.
 */

describe("l'engagé d'un poste — promis, pas payé, jamais compté deux fois", () => {
  it("un BC émis sans rien de payé engage tout son montant (« Engagé » ne reste plus à 0)", () => {
    expect(engagementDuPoste({ bc: 100_000, paye: 0, enAttente: 0 })).toBe(100_000);
  });
  it("l'ordre en attente qui PAIE le BC ne s'ajoute pas au BC", () => {
    expect(engagementDuPoste({ bc: 100_000, paye: 0, enAttente: 100_000 })).toBe(100_000);
    expect(surplusDuBc({ bc: 100_000, paye: 0, enAttente: 100_000 })).toBe(0);
  });
  it("un paiement partiel ne laisse engagé que le reste du BC", () => {
    expect(engagementDuPoste({ bc: 100_000, paye: 60_000, enAttente: 0 })).toBe(40_000);
    expect(engagementDuPoste({ bc: 100_000, paye: 60_000, enAttente: 40_000 })).toBe(40_000);
  });
  it("un BC entièrement payé n'engage plus rien (le payé est dans le consommé)", () => {
    expect(engagementDuPoste({ bc: 100_000, paye: 100_000, enAttente: 0 })).toBe(0);
    expect(engagementDuPoste({ bc: 100_000, paye: 120_000, enAttente: 0 })).toBe(0);
  });
  it("un ordre sans BC (sponsoring direct) engage son montant ; un ordre plus gros que le BC compte en entier", () => {
    expect(engagementDuPoste({ bc: 0, paye: 0, enAttente: 50_000 })).toBe(50_000);
    expect(engagementDuPoste({ bc: 100_000, paye: 0, enAttente: 120_000 })).toBe(120_000);
    expect(surplusDuBc({ bc: 100_000, paye: 0, enAttente: 30_000 })).toBe(70_000);
  });
  it("seuls les ordres émis et non réglés engagent", () => {
    expect(ordreEngage("PENDING")).toBe(true);
    expect(ordreEngage("REVISION_REQUESTED")).toBe(true);
    expect(ordreEngage("PAID")).toBe(false);
    expect(ordreEngage("CANCELLED")).toBe(false);
    expect(ordreEngage(null)).toBe(false);
  });
  it("un ordre refusé par le centre n'engage plus rien — il ne paiera jamais (ARGENT-07)", () => {
    expect(ordreEngage("PENDING", "REFUSED")).toBe(false);
    expect(ordreEngage("PENDING", "AWAITING")).toBe(true);
    expect(ordreEngage("PENDING", "APPROVED")).toBe(true);
  });
});

describe("la date d'une dépense — la courbe ne saute plus au mois de la saisie", () => {
  const saisie = new Date("2026-07-15T10:00:00.000Z");
  it("une écriture réglée au centre de paiement (date = instant de saisie) prend la date de sa facture", () => {
    const d = dateDeLaDepense({ date: saisie, createdAt: new Date(saisie.getTime() + 300), factureDu: new Date("2026-03-04T00:00:00.000Z") });
    expect(cleMois(d)).toBe("2026-03");
  });
  it("le règlement déclaré de la facture passe avant sa date d'émission", () => {
    const d = dateDeLaDepense({ date: saisie, createdAt: saisie, facturePayeeLe: new Date("2026-04-20T00:00:00.000Z"), factureDu: new Date("2026-03-04T00:00:00.000Z") });
    expect(cleMois(d)).toBe("2026-04");
  });
  it("une date CHOISIE à la saisie fait foi, même si une facture est liée", () => {
    const choisie = new Date("2026-02-10T00:00:00.000Z");
    expect(dateChoisie(choisie, saisie)).toBe(true);
    expect(dateDeLaDepense({ date: choisie, createdAt: saisie, factureDu: new Date("2026-01-01T00:00:00.000Z") })).toEqual(choisie);
  });
  it("sans rien qui la date, la dépense garde le jour de sa saisie", () => {
    expect(dateDeLaDepense({ date: saisie, createdAt: saisie })).toEqual(saisie);
    expect(dateChoisie(saisie, new Date(saisie.getTime() + 30_000))).toBe(false);
  });
  it("une date hors période est ramenée à la borne (la courbe et le compteur restent d'accord)", () => {
    const from = new Date("2026-01-01T00:00:00.000Z"), to = new Date("2026-12-31T00:00:00.000Z");
    expect(dansLaPeriode(new Date("2025-12-20T00:00:00.000Z"), from, to)).toEqual(from);
    expect(dansLaPeriode(new Date("2027-01-02T00:00:00.000Z"), from, to)).toEqual(to);
    expect(cleMois(dansLaPeriode(new Date("2026-05-02T00:00:00.000Z"), from, to))).toBe("2026-05");
  });
});
