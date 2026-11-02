import { describe, expect, it } from "vitest";
import {
  refusDeCorrection, refusDuChamp, ecartsDeCorrection, phraseDeCorrection, CHAMPS_DU_BROUILLON, type ValeursDemande,
} from "./correction-demande";

/**
 * CORRIGER SA DEMANDE DE PAIEMENT (§118.191, audit 360° R04) — la règle pure. L'ordre des refus est
 * celui de l'ÉTAT (§118.18) : la nature du dossier, sa place dans le circuit, puis l'argent.
 */
describe("Quand une demande de paiement se corrige", () => {
  it("chez le demandeur : brouillon, ou renvoyée par les Finances", () => {
    expect(refusDeCorrection({ status: "DRAFT", compagnon: false })).toBeNull();
    expect(refusDeCorrection({ status: "CHANGES_REQUESTED", compagnon: false, ordre: { status: "PENDING", centralStatus: "APPROVED" } })).toBeNull();
  });
  it("chez les Finances, elle ne bouge pas sous leurs yeux — et le refus nomme le chemin", () => {
    for (const status of ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD"]) {
      expect(refusDeCorrection({ status, compagnon: false })).toMatch(/quand elles vous le renvoient/);
    }
  });
  it("close, elle ne se corrige plus", () => {
    for (const status of ["APPROVED", "REJECTED", "CANCELLED"]) expect(refusDeCorrection({ status, compagnon: false })).toMatch(/clos/);
  });
  it("un dossier COMPAGNON se corrige dans son circuit d'origine — avant toute autre raison", () => {
    expect(refusDeCorrection({ status: "SUBMITTED", compagnon: true, ordre: { status: "PAID", centralStatus: "APPROVED" } })).toMatch(/autre circuit/);
  });
  it("l'argent parti ou refusé : la demande ne se corrige plus, et le geste qui reste est nommé", () => {
    expect(refusDeCorrection({ status: "CHANGES_REQUESTED", compagnon: false, ordre: { status: "PAID", centralStatus: "APPROVED" } })).toMatch(/déjà réglé/);
    expect(refusDeCorrection({ status: "CHANGES_REQUESTED", compagnon: false, ordre: { status: "PENDING", centralStatus: "REFUSED" } })).toMatch(/déposez-en une nouvelle/);
  });
  it("la place dans le circuit passe AVANT l'argent : chez les Finances, on ne parle pas du règlement", () => {
    expect(refusDeCorrection({ status: "UNDER_REVIEW", compagnon: false, ordre: { status: "PAID", centralStatus: "APPROVED" } })).toMatch(/chez les Finances/);
  });
});

describe("L'entité et l'urgence ne se corrigent qu'au brouillon", () => {
  it("au brouillon, tout champ se corrige", () => {
    for (const champ of CHAMPS_DU_BROUILLON) expect(refusDuChamp("DRAFT", champ)).toBeNull();
  });
  it("après transmission, l'entité (la société qui paie) et l'urgence (son motif) refusent, en nommant le geste", () => {
    expect(refusDuChamp("CHANGES_REQUESTED", "companyId")).toMatch(/déposez-la sous la bonne entité/);
    expect(refusDuChamp("CHANGES_REQUESTED", "urgency")).toMatch(/Signaler une urgence/);
  });
  it("les autres champs se corrigent après transmission", () => {
    for (const champ of ["title", "payee", "amount", "description", "dueDate", "deadlineNature"] as const) {
      expect(refusDuChamp("CHANGES_REQUESTED", champ)).toBeNull();
    }
  });
});

describe("Ce qui change — et seulement ce que le formulaire porte", () => {
  const avant: ValeursDemande = {
    title: "Stand congrès", payee: "SARL Atlas", amount: 500_000, description: null,
    dueDate: "2026-11-15", deadlineNature: "MODERATE", urgency: "WHEN_POSSIBLE", companyId: "c1",
  };
  it("un champ ABSENT ne change pas ; un champ présent mais identique non plus", () => {
    expect(ecartsDeCorrection(avant, {})).toEqual([]);
    expect(ecartsDeCorrection(avant, { title: "Stand congrès", amount: 500_000 })).toEqual([]);
  });
  it("le montant se lit en DZD, le texte entre guillemets, dans l'ordre de la fiche", () => {
    const e = ecartsDeCorrection(avant, { amount: 450_000, payee: "EURL Ziryab" });
    expect(e.map((x) => x.champ)).toEqual(["payee", "amount"]);
    expect(phraseDeCorrection(e, "facture définitive"))
      .toBe(`Demande corrigée — Bénéficiaire : « SARL Atlas » → « EURL Ziryab » ; Montant : ${(500_000).toLocaleString("fr-FR")} DZD → ${(450_000).toLocaleString("fr-FR")} DZD. Ce qui a changé : facture définitive`);
  });
  it("vider le contexte est un changement, et il se dit", () => {
    const e = ecartsDeCorrection({ ...avant, description: "ancien" }, { description: null });
    expect(e).toEqual([{ champ: "description", libelle: "Contexte", avant: "« ancien »", apres: "—" }]);
  });
  it("les codes se disent par leur libellé quand l'appelant le fournit — jamais l'identifiant brut", () => {
    const e = ecartsDeCorrection(avant, { companyId: "c2" }, { companyId: (v) => (v === "c1" ? "Adventum" : "Pharmagène") });
    expect(e[0]).toMatchObject({ avant: "Adventum", apres: "Pharmagène" });
  });
});
