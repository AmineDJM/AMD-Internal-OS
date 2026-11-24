import { describe, expect, it } from "vitest";
import { can } from "@/lib/rbac/roles";
import { refusDejaSigneAutreQualite, refusSignataireDouble, type SignaturePosee } from "./signataires-distincts";

const DM = (userId: string | null): SignaturePosee => ({ qualite: "DIRECTION_MARKETING", userId });
const FIN = (userId: string | null): SignaturePosee => ({ qualite: "FINANCES", userId });

describe("deux signatures, deux personnes (Super Admin, 24/11/2026)", () => {
  const assia = { id: "u-dm", role: "PRODUCT_MANAGER" };
  const karim = { id: "u-fin", role: "FINANCE_BUDGET_MANAGER" };

  it("la phrase dit ce qui a été signé et à qui revient l'autre place", () => {
    expect(refusDejaSigneAutreQualite("FINANCES"))
      .toBe("Vous avez déjà signé ce bon de commande pour la Direction Marketing : la signature des Finances revient à une autre personne.");
    expect(refusDejaSigneAutreQualite("DIRECTION_MARKETING"))
      .toBe("Vous avez déjà signé ce bon de commande pour les Finances : la signature de la Direction Marketing revient à une autre personne.");
  });

  it("rien de posé, ou la même place seulement : rien ne s'y oppose", () => {
    expect(refusSignataireDouble([], "DIRECTION_MARKETING", assia)).toBeNull();
    expect(refusSignataireDouble([], "FINANCES", karim)).toBeNull();
    // La même place déjà signée par la même personne relève de l'unicité de la place, pas de cette règle.
    expect(refusSignataireDouble([FIN("u-fin")], "FINANCES", karim)).toBeNull();
  });

  it("la Direction Marketing a signé : elle ne signe pas pour les Finances, une autre personne si", () => {
    expect(refusSignataireDouble([DM("u-dm")], "FINANCES", { ...assia, secondaryRole: "FINANCE_BUDGET_MANAGER" }))
      .toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect(refusSignataireDouble([DM("u-dm")], "FINANCES", karim)).toBeNull();
  });

  it("dans l'autre sens : qui a signé pour les Finances (en ligne ou copie papier) ne signe pas pour la Direction Marketing", () => {
    expect(refusSignataireDouble([FIN("u-dm")], "DIRECTION_MARKETING", assia)).toBe(refusDejaSigneAutreQualite("DIRECTION_MARKETING"));
    expect(refusSignataireDouble([FIN("u-fin")], "DIRECTION_MARKETING", assia)).toBeNull();
  });

  it("une personne qui TIENT LES DEUX FONCTIONS (Direction Marketing + droit de signer les BC) n'en signe qu'une", () => {
    const cumul = { id: "u-cumul", role: "PRODUCT_MANAGER", secondaryRole: "FINANCE_BUDGET_MANAGER" };
    // PRÉMISSE : son « autre rôle » porte bien « Modifier » sur Bons de commande — le droit de signer pour les Finances.
    expect(can("FINANCE_BUDGET_MANAGER", "PURCHASE_ORDERS", "UPDATE")).toBe(true);
    expect(refusSignataireDouble([DM("u-cumul")], "FINANCES", cumul)).toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect(refusSignataireDouble([FIN("u-cumul")], "DIRECTION_MARKETING", cumul)).toBe(refusDejaSigneAutreQualite("DIRECTION_MARKETING"));
    // Les rôles inversés ne changent rien.
    expect(refusSignataireDouble([DM("u-cumul")], "FINANCES", { ...cumul, role: "FINANCE_BUDGET_MANAGER", secondaryRole: "PRODUCT_MANAGER" }))
      .toBe(refusDejaSigneAutreQualite("FINANCES"));
  });

  it("le SUPER ADMIN tient les deux places — par son rôle principal comme par son « autre rôle »", () => {
    expect(refusSignataireDouble([DM("u-sa")], "FINANCES", { id: "u-sa", role: "SUPER_ADMIN" })).toBeNull();
    expect(refusSignataireDouble([FIN("u-sa")], "DIRECTION_MARKETING", { id: "u-sa", role: "SUPER_ADMIN", secondaryRole: null })).toBeNull();
    expect(refusSignataireDouble([DM("u-sa2")], "FINANCES", { id: "u-sa2", role: "PRODUCT_MANAGER", secondaryRole: "SUPER_ADMIN" })).toBeNull();
    expect(refusSignataireDouble([FIN("u-sa2")], "DIRECTION_MARKETING", { id: "u-sa2", role: "FINANCE_BUDGET_MANAGER", secondaryRole: "SUPER_ADMIN" })).toBeNull();
  });

  it("une signature sans compte connu (`userId` vide) n'est attribuée à personne", () => {
    expect(refusSignataireDouble([DM(null)], "FINANCES", karim)).toBeNull();
  });
});
