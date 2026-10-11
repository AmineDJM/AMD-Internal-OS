import { describe, expect, it } from "vitest";
import { refusDuStatutManuel, refusDeReouverture, STATUTS_MANUELS, estStatutManuel } from "./statut-manuel";

/**
 * Plus aucun statut à la main (Direction, 10/2026) : l'assistante n'a que deux gestes. Ce banc disait
 * « quatre statuts se posent à la main » (§118.191) — en attente d'un tiers, d'un document, bloquer,
 * reprendre : ces gestes sont retirés, il dit désormais que tout changement à la main est refusé, et
 * que le refus nomme la porte.
 */
describe("Le statut à la main : plus rien ne se pose d'ici", () => {
  const r = (courant: string, cible: string, motif: string | null = null) => refusDuStatutManuel({ courant, cible, motif });

  it("aucun statut ne se pose à la main", () => {
    expect(STATUTS_MANUELS).toEqual([]);
    for (const s of ["NEW", "IN_PROGRESS", "AWAITING_EXTERNAL", "AWAITING_DOCUMENT", "BLOCKED", "DONE"]) expect(estStatutManuel(s)).toBe(false);
  });

  it("les étapes intermédiaires sont refusées, et le refus nomme les deux gestes", () => {
    for (const cible of ["AWAITING_EXTERNAL", "AWAITING_DOCUMENT", "BLOCKED", "IN_PROGRESS"]) {
      expect(r("IN_PROGRESS", cible, "x")).toMatch(/« Commencer le traitement » et « Fin du traitement »/);
    }
    expect(r("NEW", "IN_PROGRESS")).toMatch(/deux gestes/);
  });

  it("terminer et annuler ont leur porte, et le refus la nomme", () => {
    expect(r("IN_PROGRESS", "DONE")).toMatch(/« Fin du traitement »/);
    expect(r("IN_PROGRESS", "CANCELLED")).toMatch(/« Annuler la demande »/);
  });

  it("l'ÉTAT D'ABORD : une demande close refuse avant même de regarder la cible", () => {
    expect(r("CANCELLED", "DONE")).toMatch(/ne se rouvre pas/);
    expect(r("DONE", "BLOCKED")).toMatch(/« Rouvrir »/);
  });
});

describe("Rouvrir : une demande traitée, avec son motif", () => {
  it("seulement traitée ; jamais annulée ; le motif après l'état", () => {
    expect(refusDeReouverture({ courant: "DONE", motif: "x" })).toBeNull();
    expect(refusDeReouverture({ courant: "CANCELLED", motif: null })).toMatch(/ne se rouvre pas/);
    expect(refusDeReouverture({ courant: "IN_PROGRESS", motif: null })).toBe("Seule une demande traitée se rouvre.");
    expect(refusDeReouverture({ courant: "DONE", motif: null })).toMatch(/Dites pourquoi/);
  });
});
