import { describe, it, expect } from "vitest";
import type { HrRequestStatus } from "@prisma/client";
import { refusTransitionDemandeRh, suitesTraitementRh, hrNature } from "./hr-request-flow";

/** Le graphe des statuts du traitement RH (`processHrRequest`) — audit sécurité 11/2026. Pur. */
const TOUS: HrRequestStatus[] = ["PENDING", "IN_PROGRESS", "READY", "DELIVERED", "APPROVED", "REJECTED", "CANCELLED"];

describe("refusTransitionDemandeRh — document (attestation, relevé, ordre de mission…)", () => {
  it("fait avancer la préparation : soumise → en préparation → prête → remise", () => {
    expect(refusTransitionDemandeRh("DOCUMENT", "PENDING", "IN_PROGRESS")).toBeNull();
    expect(refusTransitionDemandeRh("DOCUMENT", "IN_PROGRESS", "READY")).toBeNull();
    expect(refusTransitionDemandeRh("DOCUMENT", "READY", "DELIVERED")).toBeNull();
    expect(refusTransitionDemandeRh("DOCUMENT", "PENDING", "READY")).toBeNull();
    expect(refusTransitionDemandeRh("DOCUMENT", "IN_PROGRESS", "REJECTED")).toBeNull();
  });

  it("ne rouvre pas un état final et ne recule pas", () => {
    for (const fin of ["DELIVERED", "REJECTED"] as const) {
      for (const vers of TOUS.filter((s) => s !== fin)) expect(refusTransitionDemandeRh("DOCUMENT", fin, vers), `${fin}→${vers}`).not.toBeNull();
    }
    expect(refusTransitionDemandeRh("DOCUMENT", "READY", "PENDING")).toMatch(/impossible.*« Remise »/);
    expect(refusTransitionDemandeRh("DOCUMENT", "DELIVERED", "IN_PROGRESS")).toMatch(/état final/);
  });

  it("« Accordée » et « Annulée » ne se posent pas ici, avec le remède", () => {
    expect(refusTransitionDemandeRh("DOCUMENT", "PENDING", "APPROVED")).toMatch(/congé/);
    expect(refusTransitionDemandeRh("DOCUMENT", "PENDING", "CANCELLED")).toMatch(/Seul le salarié annule/);
  });

  it("même statut = note seule : permise, sauf sur une demande annulée", () => {
    for (const s of TOUS.filter((x) => x !== "CANCELLED")) expect(refusTransitionDemandeRh("DOCUMENT", s, s)).toBeNull();
    expect(refusTransitionDemandeRh("DOCUMENT", "CANCELLED", "CANCELLED")).toMatch(/annulé/);
    expect(refusTransitionDemandeRh("DOCUMENT", "CANCELLED", "IN_PROGRESS")).toMatch(/annulé/);
  });
});

describe("refusTransitionDemandeRh — les décisions ont leur porte", () => {
  it("congé / absence : aucun changement d'état par le traitement (Accorder / Refuser)", () => {
    expect(hrNature("ANNUAL_LEAVE")).toBe("APPROVAL");
    for (const de of TOUS) for (const vers of TOUS.filter((s) => s !== de)) {
      expect(refusTransitionDemandeRh("APPROVAL", de, vers), `${de}→${vers}`).not.toBeNull();
    }
    expect(refusTransitionDemandeRh("APPROVAL", "PENDING", "READY")).toMatch(/Accorder/);
  });

  it("note de frais : prise en charge et remise, la validation passe par « Valider / Refuser »", () => {
    expect(refusTransitionDemandeRh("EXPENSE", "PENDING", "IN_PROGRESS")).toBeNull();
    expect(refusTransitionDemandeRh("EXPENSE", "READY", "DELIVERED")).toBeNull();
    expect(refusTransitionDemandeRh("EXPENSE", "PENDING", "READY")).toMatch(/originaux/);
    expect(refusTransitionDemandeRh("EXPENSE", "IN_PROGRESS", "REJECTED")).toMatch(/Valider/);
  });

  it("entrevue : « Prête » vient de la date acceptée", () => {
    expect(refusTransitionDemandeRh("INTERVIEW", "PENDING", "REJECTED")).toBeNull();
    expect(refusTransitionDemandeRh("INTERVIEW", "IN_PROGRESS", "READY")).toMatch(/date/);
  });

  it("suitesTraitementRh : rien depuis un état final", () => {
    expect(suitesTraitementRh("DOCUMENT", "DELIVERED")).toEqual([]);
    expect(suitesTraitementRh("APPROVAL", "PENDING")).toEqual([]);
  });
});
