import { describe, expect, it } from "vitest";
import { horsDeSaGamme, rolesAPrevenir, superviseurQuiTientLEtape } from "./etape-gamme";

const NS = ["NATIONAL_SALES"];
const nsA = { id: "nsA", role: "NATIONAL_SALES" };
const nsB = { id: "nsB", role: "NATIONAL_SALES" };

describe("l'étape du National Sales revient au superviseur de la gamme (ADPRO-06)", () => {
  it("le superviseur qui porte le rôle tient l'étape ; un autre National Sales en est exclu", () => {
    expect(superviseurQuiTientLEtape(NS, nsA)).toEqual(nsA);
    expect(horsDeSaGamme(NS, nsA, nsA)).toBe(false);
    expect(horsDeSaGamme(NS, nsB, nsA)).toBe(true);
  });

  it("une gamme sans superviseur, ou dont le superviseur ne porte pas le rôle, garde l'étape ouverte au rôle", () => {
    expect(horsDeSaGamme(NS, nsB, null)).toBe(false);
    expect(horsDeSaGamme(NS, nsB, { id: "pm", role: "PRODUCT_MANAGER" })).toBe(false);
    expect(horsDeSaGamme(NS, nsB, { id: "x", role: "PRODUCT_MANAGER", secondaryRole: "NATIONAL_SALES" })).toBe(true);
  });

  it("qui entre par un AUTRE rôle de l'étape n'est pas concerné ; une étape sans le rôle non plus", () => {
    expect(horsDeSaGamme(["NATIONAL_SALES", "DIRECTION"], { id: "d", role: "DIRECTION" }, nsA)).toBe(false);
    expect(horsDeSaGamme(["OPERATIONS_DIRECTOR"], nsB, nsA)).toBe(false);
  });

  it("la notification : le rôle part quand un superviseur tient l'étape (il est prévenu nommément)", () => {
    expect(rolesAPrevenir(["NATIONAL_SALES", "SUPER_ADMIN"], nsA)).toEqual(["SUPER_ADMIN"]);
    expect(rolesAPrevenir(["NATIONAL_SALES", "SUPER_ADMIN"], null)).toEqual(["NATIONAL_SALES", "SUPER_ADMIN"]);
  });
});
