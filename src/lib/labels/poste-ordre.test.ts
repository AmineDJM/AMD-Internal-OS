import { describe, it, expect } from "vitest";
import { posteDeLOrdre } from "../labels";

/**
 * LE « POSTE » D'UN ORDRE CHEZ LES FINANCES (recette sponsoring, 23/11/2026).
 *
 * Les ordres OD-2026-043 à 046, nés des postes du sponsoring SPO-2026-021, portent la catégorie comptable
 * `EVENEMENT` — posée par le code pour toute opération Ad & Pro — et s'affichaient « Événement / Table ronde »
 * dans « Paiements à faire », quand le centre de paiement les disait « Sponsoring ».
 */
describe("posteDeLOrdre", () => {
  it("un ordre d'opération Ad & Pro montre son ORIGINE, pas « Événement / Table ronde »", () => {
    expect(posteDeLOrdre("EVENEMENT", "SPONSORING")).toBe("Sponsoring");
    expect(posteDeLOrdre("EVENEMENT", "CONGRESS_NATIONAL")).toBe("Prise en charge Nationale");
    expect(posteDeLOrdre("EVENEMENT", "EVENT")).toBe("Événement");
  });

  it("sans origine lisible, la catégorie reste ce qu'elle dit", () => {
    expect(posteDeLOrdre("EVENEMENT", null)).toBe("Événement / Table ronde");
    expect(posteDeLOrdre("EVENEMENT", "TYPE_INCONNU")).toBe("Événement / Table ronde");
  });

  it("les catégories précises ne sont pas remplacées par l'origine", () => {
    expect(posteDeLOrdre("FOURNISSEUR", "ADMIN_REQUEST")).toBe("Achats fournisseurs");
    expect(posteDeLOrdre("SALAIRE", "PAYROLL")).toBe("Salaires / Personnel");
    expect(posteDeLOrdre("CATEGORIE_NOUVELLE", null)).toBe("CATEGORIE_NOUVELLE");
  });
});
