import { describe, expect, it } from "vitest";
import { ENTITE_SANS, choisirEntite } from "./domaine/entite-centre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENTITÉ OUVERTE AU CENTRE DE PAIEMENT — le seul filtre de l'écran (24/11/2026 : une file
 * unique par entité, toutes origines confondues). La règle pure : une valeur d'adresse forgée ou
 * périmée ne désigne rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("l'entité affichée", () => {
  const entites = [
    { cle: "a", enAttente: 1 },
    { cle: "b", enAttente: 5 },
    { cle: ENTITE_SANS, enAttente: 0 },
  ];

  it("la demande de l'adresse l'emporte quand elle désigne une pastille PRÉSENTE", () => {
    expect(choisirEntite(entites, "a", "b")).toBe("a");
    expect(choisirEntite(entites, ENTITE_SANS, "b")).toBe(ENTITE_SANS);
  });

  it("une valeur forgée ou périmée ne désigne rien : retombée sur la préférence, puis sur l'entité qui attend le plus", () => {
    expect(choisirEntite(entites, "societe-d-un-autre", "a")).toBe("a");
    expect(choisirEntite(entites, "societe-d-un-autre", "autre-aussi")).toBe("b");
    expect(choisirEntite(entites, null, null)).toBe("b");
    expect(choisirEntite([{ cle: "x", enAttente: 0 }, { cle: "y", enAttente: 0 }], null, null), "à égalité, la première").toBe("x");
    expect(choisirEntite([], "a", "b")).toBeNull();
  });
});
