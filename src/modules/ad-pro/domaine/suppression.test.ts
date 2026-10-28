import { describe, it, expect } from "vitest";
import { peutSupprimerDemandeAdPro, estDemandeAdProSupprimable, DEMANDES_AD_PRO_SUPPRIMABLES } from "./suppression";
import { isDeletableKind } from "@/lib/admin-delete-registry";

/**
 * QUI SUPPRIME UNE DEMANDE AD & PRO (§118.175) — le Super Admin, le directeur des opérations,
 * la directrice marketing. Chaque cas nomme le défaut qu'il empêcherait.
 */
describe("supprimer une demande Ad & Pro", () => {
  it("le Super Admin, comme avant", () => {
    expect(peutSupprimerDemandeAdPro({ role: "SUPER_ADMIN", estCheffeMarketing: false })).toBe(true);
  });

  it("le directeur des opérations sous ses DEUX libellés — rôle principal ou casquette secondaire", () => {
    expect(peutSupprimerDemandeAdPro({ role: "DIRECTION", estCheffeMarketing: false })).toBe(true);
    expect(peutSupprimerDemandeAdPro({ role: "OPERATIONS_DIRECTOR", estCheffeMarketing: false })).toBe(true);
    expect(peutSupprimerDemandeAdPro({ role: "MEDICAL_DELEGATE", secondaryRole: "OPERATIONS_DIRECTOR", estCheffeMarketing: false })).toBe(true);
  });

  it("la directrice marketing — la CHEFFE lue sur l'organigramme, pas toute porteuse du rôle", () => {
    expect(peutSupprimerDemandeAdPro({ role: "PRODUCT_MANAGER", estCheffeMarketing: true })).toBe(true);
    // Sans ce cas, une règle qui ouvrirait la suppression au rôle entier passerait : un référent
    // de gamme porte aussi « Direction Marketing », et la Direction a parlé d'UNE personne.
    expect(peutSupprimerDemandeAdPro({ role: "PRODUCT_MANAGER", estCheffeMarketing: false })).toBe(false);
  });

  it("personne d'autre — et surtout pas l'auteur typique d'une demande", () => {
    for (const role of ["MEDICAL_DELEGATE", "NATIONAL_SALES", "FINANCE_BUDGET_MANAGER", "DIRECTION_ASSISTANT", "GENERAL_MANAGER"]) {
      expect(peutSupprimerDemandeAdPro({ role, estCheffeMarketing: false }), role).toBe(false);
    }
  });

  it("les sept natures du pôle, et elles existent au registre de suppression (la corbeille sait les rendre)", () => {
    expect(DEMANDES_AD_PRO_SUPPRIMABLES).toHaveLength(7);
    for (const k of DEMANDES_AD_PRO_SUPPRIMABLES) expect(isDeletableKind(k), k).toBe(true);
    expect(estDemandeAdProSupprimable("LEGAL_DOCUMENT")).toBe(false);
  });
});
