import { describe, it, expect } from "vitest";
import { sitsOnPaymentCentre } from "./authorization";

describe("centre de paiement — le DG et le Super Admin siègent, en rôle principal ou secondaire (15/11/2026)", () => {
  it("le DG en rôle principal ou en « autre rôle »", () => {
    expect(sitsOnPaymentCentre({ role: "GENERAL_MANAGER" })).toBe(true);
    expect(sitsOnPaymentCentre({ role: "PRODUCT_MANAGER", secondaryRole: "GENERAL_MANAGER" })).toBe(true);
    expect(sitsOnPaymentCentre({ role: "FINANCE_BUDGET_MANAGER", secondaryRole: "SUPER_ADMIN" })).toBe(true);
  });
  it("les autres non, sauf siège nommé", () => {
    expect(sitsOnPaymentCentre({ role: "FINANCE_BUDGET_MANAGER" })).toBe(false);
    expect(sitsOnPaymentCentre({ role: "PRODUCT_MANAGER", secondaryRole: null })).toBe(false);
    expect(sitsOnPaymentCentre({ role: "DIRECTION_ASSISTANT", access: { paymentCentreSeat: true } })).toBe(true);
  });
});
