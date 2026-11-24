import { describe, expect, it } from "vitest";
import {
  etatHistorique, etatQuestion, joursAvantRappel, lireSaisieReglement, lireVueBanque, noteDeReference, phraseRelances,
  rappelDu, refusRappelManuel, EVT_QUESTION, EVT_RAPPEL, EVT_REPONSE, EVT_REPONSE_LUE,
} from "./banque-paiements";

const NOW = new Date("2026-11-24T10:00:00Z"); // 11 h à Alger

describe("la saisie du panneau « Payer »", () => {
  it("vide : aujourd'hui (l'instant exact), virement, sans référence — le geste d'avant", () => {
    const r = lireSaisieReglement({}, { now: NOW });
    expect(r).toEqual({ ok: true, saisie: { date: NOW, mode: "BANK_TRANSFER", reference: null, duJour: true } });
  });
  it("une remise de caisse sort en espèces par défaut", () => {
    const r = lireSaisieReglement({}, { now: NOW, remise: true });
    expect(r.ok && r.saisie.mode).toBe("CASH");
  });
  it("un jour passé s'écrit à midi UTC (le même jour à Alger), avec le mode et la référence saisis", () => {
    const r = lireSaisieReglement({ date: "2026-11-20", mode: "CHEQUE", reference: "  CHQ-0042 " }, { now: NOW });
    expect(r).toEqual({ ok: true, saisie: { date: new Date("2026-11-20T12:00:00Z"), mode: "CHEQUE", reference: "CHQ-0042", duJour: false } });
  });
  it("refuse une date future, un mode inconnu, une référence trop longue — et dit le remède", () => {
    expect(lireSaisieReglement({ date: "2026-11-25" }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringMatching(/futur/) });
    expect(lireSaisieReglement({ mode: "BITCOIN" }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringMatching(/virement, chèque ou espèces/) });
    expect(lireSaisieReglement({ reference: "x".repeat(81) }, { now: NOW })).toMatchObject({ ok: false });
    expect(lireSaisieReglement({ date: "24/11/2026" }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringMatching(/illisible/) });
  });
  it("la référence va dans les notes de l'écriture (la « Réf. facture » reste celle de la facture)", () => {
    expect(noteDeReference("VIR-1")).toBe("Référence du paiement : VIR-1");
    expect(noteDeReference(null)).toBeNull();
  });
});

describe("les onglets et l'historique", () => {
  it("`?vue=` : trois onglets, « À payer » par défaut", () => {
    expect(lireVueBanque(undefined)).toBe("a-payer");
    expect(lireVueBanque("reportes")).toBe("reportes");
    expect(lireVueBanque("payes")).toBe("payes");
    expect(lireVueBanque("n-importe")).toBe("a-payer");
  });
  it("un ordre ANNULÉ dit « Annulé », jamais « Non payé » ; un payé dit sa date", () => {
    expect(etatHistorique({ status: "CANCELLED", paidDate: null })).toBe("Annulé");
    expect(etatHistorique({ status: "PAID", paidDate: new Date("2026-11-18T09:00:00Z") })).toBe("Payé le 18/11/2026");
  });
});

describe("la question des Finances, lue sur le fil", () => {
  const D = "demandeur";
  const F = "finances";
  const at = (h: number) => new Date(Date.UTC(2026, 10, 20, h));
  it("sans question : rien", () => {
    expect(etatQuestion([{ kind: "COMMENT", actorId: D, at: at(8) }], D).etat).toBeNull();
  });
  it("question → en attente ; réponse du demandeur → reçue ; lue → rien ; nouvelle question → en attente", () => {
    const q = { kind: EVT_QUESTION, actorId: F, at: at(9) };
    expect(etatQuestion([q], D)).toMatchObject({ etat: "EN_ATTENTE_DEMANDEUR", questionPar: F });
    // Un message d'un TIERS ne répond pas.
    expect(etatQuestion([q, { kind: "COMMENT", actorId: "autre", at: at(10) }], D).etat).toBe("EN_ATTENTE_DEMANDEUR");
    const rep = { kind: EVT_REPONSE, actorId: D, at: at(11) };
    expect(etatQuestion([q, rep], D).etat).toBe("REPONSE_RECUE");
    // Le message libre du demandeur répond aussi.
    expect(etatQuestion([q, { kind: "COMMENT", actorId: D, at: at(11) }], D).etat).toBe("REPONSE_RECUE");
    const lue = { kind: EVT_REPONSE_LUE, actorId: F, at: at(12) };
    expect(etatQuestion([q, rep, lue], D).etat).toBeNull();
    expect(etatQuestion([q, rep, lue, { kind: EVT_QUESTION, actorId: F, at: at(13) }], D).etat).toBe("EN_ATTENTE_DEMANDEUR");
  });
  it("le rappel automatique part N jours après le dernier signe des Finances, et repart de chaque rappel", () => {
    const q = { kind: EVT_QUESTION, actorId: F, at: at(9) };
    const l = etatQuestion([q], D);
    expect(rappelDu(l, 3, new Date(at(9).getTime() + 2 * 86_400_000))).toBe(false);
    expect(rappelDu(l, 3, new Date(at(9).getTime() + 3 * 86_400_000))).toBe(true);
    const apresRappel = etatQuestion([q, { kind: EVT_RAPPEL, actorId: null, at: new Date(at(9).getTime() + 3 * 86_400_000) }], D);
    expect(rappelDu(apresRappel, 3, new Date(at(9).getTime() + 4 * 86_400_000))).toBe(false);
    expect(rappelDu(etatQuestion([q, { kind: EVT_REPONSE, actorId: D, at: at(10) }], D), 3, new Date(at(9).getTime() + 9 * 86_400_000))).toBe(false);
  });
  it("le rappel manuel : une question en attente, et pas deux fois en 24 h", () => {
    const l = etatQuestion([{ kind: EVT_QUESTION, actorId: F, at: at(9) }], D);
    expect(refusRappelManuel(l, at(12))).toMatch(/24 heures/);
    expect(refusRappelManuel(l, new Date(at(9).getTime() + 86_400_000))).toBeNull();
    expect(refusRappelManuel(etatQuestion([], D), at(12))).toMatch(/Aucune question/);
  });
  it("le délai du rappel se règle (3 jours par défaut, borné)", () => {
    expect(joursAvantRappel(undefined)).toBe(3);
    expect(joursAvantRappel("5")).toBe(5);
    expect(joursAvantRappel("0")).toBe(3);
    expect(joursAvantRappel("abc")).toBe(3);
  });
});

describe("les relances du demandeur, sur la ligne", () => {
  it("« Relancé n fois — dernière relance le … », ou rien", () => {
    expect(phraseRelances([])).toBeNull();
    expect(phraseRelances([new Date("2026-11-20T09:00:00Z"), new Date("2026-11-23T09:00:00Z")]))
      .toBe("Relancé 2 fois par le demandeur — dernière relance le 23/11/2026");
  });
});
