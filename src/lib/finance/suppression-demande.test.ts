import { describe, expect, it } from "vitest";
import { refusDeSuppression } from "./correction-demande";
import { refusOrdreFerme, ORDRE_NON_ANNULE } from "@/lib/payments/authorization";

/** SUPPRIMER UNE DEMANDE RETIRÉE ; UN ORDRE ANNULÉ QUITTE LE CENTRE (Direction, 19/10/2026) — les règles pures. */
describe("refusDeSuppression — ce qui se supprime définitivement", () => {
  it("une demande retirée dont l'ordre est annulé, ou un brouillon sans ordre → se supprime", () => {
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: false, ordre: { status: "CANCELLED" } })).toBeNull();
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: false, ordre: null })).toBeNull();
    expect(refusDeSuppression({ status: "DRAFT", compagnon: false, ordre: null })).toBeNull();
  });

  it("une demande vivante se retire d'abord — c'est le retrait qui annule l'ordre au centre", () => {
    for (const status of ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED", "APPROVED"]) {
      expect(refusDeSuppression({ status, compagnon: false, ordre: { status: "PENDING" } }), status).toMatch(/^Retirez d'abord la demande/);
    }
  });

  it("un paiement SORTI interdit la suppression, quel que soit le statut du dossier", () => {
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: false, ordre: { status: "PAID", reference: "OD-1" } })).toMatch(/OD-1 est déjà sorti/);
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: false, ordre: { status: "CANCELLED", transactionId: "tx" } })).toMatch(/déjà sorti/);
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: false, ordre: { status: "CANCELLED", paidDate: new Date() } })).toMatch(/déjà sorti/);
  });

  it("un compagnon ne se supprime pas d'ici ; une demande refusée garde son motif ; un ordre encore ouvert bloque", () => {
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: true, ordre: null })).toMatch(/accompagne un ordre/);
    expect(refusDeSuppression({ status: "REJECTED", compagnon: false, ordre: { status: "CANCELLED" } })).toMatch(/refusée/);
    expect(refusDeSuppression({ status: "CANCELLED", compagnon: false, ordre: { status: "PENDING" } })).toMatch(/encore ouvert au centre/);
  });
});

describe("refusOrdreFerme — le centre ne décide pas sur un ordre annulé ou réglé", () => {
  it("annulé ou réglé → refus nommé ; à exécuter ou en révision → le centre décide", () => {
    expect(refusOrdreFerme("CANCELLED", "OD-9")).toMatch(/OD-9 a été annulé/);
    expect(refusOrdreFerme("PAID")).toMatch(/déjà réglé/);
    expect(refusOrdreFerme("PENDING")).toBeNull();
    expect(refusOrdreFerme("REVISION_REQUESTED")).toBeNull();
  });

  it("le filtre des lectures du centre écarte les ordres annulés", () => {
    expect(ORDRE_NON_ANNULE).toEqual({ status: { not: "CANCELLED" } });
  });
});
