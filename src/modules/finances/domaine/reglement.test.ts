import { describe, expect, it } from "vitest";
import { chantierPaiementClos, etatDeLOrdre } from "./reglement";

/**
 * « LE PAIEMENT DE CE DOSSIER EST FAIT » — seulement sur un ordre RÉGLÉ (§118.148).
 *
 * Trois gestes le déclaraient sans qu'aucun ordre ne l'ait été ; chaque cas ci-dessous nomme le
 * faux succès qu'il ferait réapparaître.
 */
describe("etatDeLOrdre — deux colonnes, un état", () => {
  it("PAYÉ l'emporte sur tout : un ordre réglé l'a été après l'autorisation", () => {
    expect(etatDeLOrdre({ status: "PAID", centralStatus: "APPROVED" })).toBe("REGLE");
    expect(etatDeLOrdre({ status: "PAID", centralStatus: "NOT_REQUIRED" })).toBe("REGLE");
  });
  it("AUTORISÉ n'est pas PAYÉ — c'est la confusion que ce module existe pour empêcher", () => {
    expect(etatDeLOrdre({ status: "PENDING", centralStatus: "APPROVED" })).toBe("AUX_FINANCES");
  });
  it("en attente du centre, ou d'une réponse au centre", () => {
    for (const c of ["AWAITING", "CHANGES_REQUESTED", "INFO_REQUESTED"]) {
      expect(etatDeLOrdre({ status: "PENDING", centralStatus: c }), c).toBe("AU_CENTRE");
    }
  });
  it("refusé par le centre, et annulé — un ordre annulé ne règle rien", () => {
    expect(etatDeLOrdre({ status: "PENDING", centralStatus: "REFUSED" })).toBe("REFUSE");
    expect(etatDeLOrdre({ status: "CANCELLED", centralStatus: "APPROVED" })).toBe("NON_ENVOYE");
  });
});

describe("chantierPaiementClos — le chantier « paiement » ne se clôt plus d'un clic", () => {
  it("aucun règlement : refus qui nomme le chemin (facture → règlement → centre)", () => {
    const r = chantierPaiementClos([]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toMatch(/centre de paiement/);
    expect(r.ok ? "" : r.raison).toMatch(/Pièces liées/);
  });
  it("UN règlement encore au centre tient le chantier ouvert, et le refus le NOMME", () => {
    const r = chantierPaiementClos([
      { libelle: "ordre OD-1", etat: "REGLE" },
      { libelle: "ordre OD-2", etat: "AU_CENTRE" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toContain("OD-2");
    expect(r.ok ? "" : r.raison).not.toContain("OD-1");
  });
  it("une facture pas envoyée au règlement tient aussi le chantier ouvert", () => {
    expect(chantierPaiementClos([{ libelle: "facture F-9", etat: "NON_ENVOYE" }]).ok).toBe(false);
  });
  it("tout réglé → le chantier se clôt", () => {
    expect(chantierPaiementClos([{ libelle: "ordre OD-1", etat: "REGLE" }, { libelle: "facture F-1", etat: "REGLE" }]).ok).toBe(true);
  });
});
