import { describe, expect, it } from "vitest";
import { statutAffiche, chezQui, gestesDuTraitement, lireParticipants, typeRetire, STATUTS_FILTRABLES, refusFinApresDecision, refusFinDevisPromo } from "./traitement";
import { REQUEST_TYPES } from "@/lib/admin-requests";

/** Le traitement au secrétariat : deux gestes (Direction, 10/2026). */
describe("Deux gestes : Commencer le traitement, Fin du traitement", () => {
  it("une demande neuve se commence — et ne se termine pas avant", () => {
    expect(gestesDuTraitement("NEW", false)).toEqual({ commencer: true, terminer: false });
  });
  it("commencée, elle se termine", () => {
    expect(gestesDuTraitement("IN_PROGRESS", true)).toEqual({ commencer: false, terminer: true });
  });
  it("remise en cours par un accord sans avoir été commencée : elle se commence", () => {
    expect(gestesDuTraitement("IN_PROGRESS", false)).toEqual({ commencer: true, terminer: false });
  });
  it("une ancienne demande dans une étape retirée se termine par « Fin du traitement »", () => {
    for (const s of ["AWAITING_EXTERNAL", "AWAITING_DOCUMENT", "BLOCKED", "AWAITING_VALIDATION", "AWAITING_PAYMENT"]) {
      expect(gestesDuTraitement(s, false)).toEqual({ commencer: false, terminer: true });
    }
  });
  it("traitée ou annulée : plus aucun geste", () => {
    expect(gestesDuTraitement("DONE", true)).toEqual({ commencer: false, terminer: false });
    expect(gestesDuTraitement("CANCELLED", false)).toEqual({ commencer: false, terminer: false });
  });
});

describe("Ce que lit le demandeur", () => {
  it("les étapes retirées se lisent « En cours »", () => {
    expect(statutAffiche("AWAITING_EXTERNAL")).toBe("IN_PROGRESS");
    expect(statutAffiche("AWAITING_DOCUMENT")).toBe("IN_PROGRESS");
    expect(statutAffiche("BLOCKED", "pièce manquante")).toBe("IN_PROGRESS");
  });
  it("le refus d'un validateur reste une décision ; le reste ne bouge pas", () => {
    expect(statutAffiche("BLOCKED", null)).toBe("BLOCKED");
    for (const s of ["NEW", "IN_PROGRESS", "AWAITING_VALIDATION", "AWAITING_PAYMENT", "DONE", "CANCELLED"]) expect(statutAffiche(s)).toBe(s);
  });
  it("en cours — chez l'assistante de direction", () => {
    expect(chezQui("IN_PROGRESS")).toBe("chez l'assistante de direction");
    expect(chezQui("NEW")).toBe("chez l'assistante de direction");
    expect(chezQui("DONE")).toBeNull();
  });
  it("le filtre ne propose plus les étapes retirées", () => {
    expect(STATUTS_FILTRABLES).not.toContain("AWAITING_EXTERNAL");
    expect(STATUTS_FILTRABLES).not.toContain("AWAITING_DOCUMENT");
  });
});

describe("Types retirés et participants", () => {
  it("« Mission chauffeur » ne se crée plus, mais se relit", () => {
    expect(typeRetire("DRIVER")).toBe(true);
    expect(REQUEST_TYPES.map((t) => t.value)).not.toContain("DRIVER");
    expect(REQUEST_TYPES.map((t) => t.value)).not.toContain("HR_SIMPLE");
  });
  it("les participants se lisent sans doublon, et rien d'autre", () => {
    expect(lireParticipants({ participantIds: ["a", "b", "a", "", 3] })).toEqual(["a", "b"]);
    expect(lireParticipants(null)).toEqual([]);
    expect(lireParticipants({ participantIds: "a" })).toEqual([]);
  });
});

describe("audit du 14/10/2026 — la fin après une décision", () => {
  it("la dernière approbation fait foi", () => {
    expect(refusFinApresDecision(null)).toBeNull();
    expect(refusFinApresDecision({ status: "APPROVED" })).toBeNull();
    expect(refusFinApresDecision({ status: "PENDING" })).toMatch(/en attente/);
    expect(refusFinApresDecision({ status: "REJECTED" })).toMatch(/s'annule/);
    expect(refusFinApresDecision({ status: "CHANGES_REQUESTED" })).toMatch(/modification/);
  });
  it("une demande de devis promo ne se termine pas avant la retranscription", () => {
    expect(refusFinDevisPromo("QUOTE_REQUESTED")).toMatch(/Retranscription terminée/);
    expect(refusFinDevisPromo("REVIEW_REQUESTER")).toBeNull();
    expect(refusFinDevisPromo(null)).toBeNull();
  });
});
