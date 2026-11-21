import { describe, it, expect } from "vitest";
import { suitSansDetails } from "./suivi-delegue";

describe("suitSansDetails — le délégué médical suit sans les montants (recette 21/11/2026)", () => {
  it("un délégué médical seul suit sans les détails", () => {
    expect(suitSansDetails({ role: "MEDICAL_DELEGATE" })).toBe(true);
    expect(suitSansDetails({ role: "MEDICAL_DELEGATE", secondaryRole: null })).toBe(true);
  });
  it("un rôle secondaire qui décide ou exécute rend les détails", () => {
    for (const r of ["PRODUCT_MANAGER", "SUPER_ADMIN", "NATIONAL_SALES", "DIRECTION_ASSISTANT"]) {
      expect(suitSansDetails({ role: "MEDICAL_DELEGATE", secondaryRole: r })).toBe(false);
    }
  });
  it("les autres rôles voient les détails ; un compte inconnu aussi (rien n'est caché par défaut)", () => {
    expect(suitSansDetails({ role: "NATIONAL_SALES", secondaryRole: "MEDICAL_DELEGATE" })).toBe(false);
    expect(suitSansDetails(null)).toBe(false);
  });
});
