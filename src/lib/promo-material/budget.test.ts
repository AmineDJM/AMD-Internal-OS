import { describe, expect, it } from "vitest";
import { engageDuDossierPromo, peutImputerMaterielPromo, refusImputationPromo, totalBcSignes } from "@/lib/promo-material/budget";

/** LE MATÉRIEL PROMOTIONNEL AU BUDGET — les règles pures (point 21, 27/10). */
describe("l'engagé d'un dossier de matériel promotionnel", () => {
  it("seuls les BC SIGNÉS engagent", () => {
    expect(totalBcSignes([{ montant: 500_000, signe: true }, { montant: 300_000, signe: false }])).toBe(500_000);
    expect(engageDuDossierPromo({ bcs: [{ montant: 300_000, signe: false }], ordres: [] })).toBe(0);
  });
  it("ce que les ordres vivants paient déjà sort de l'engagé — jamais deux fois le même dinar", () => {
    const bcs = [{ montant: 500_000, signe: true }];
    expect(engageDuDossierPromo({ bcs, ordres: [{ montant: 200_000, statut: "PENDING" }] })).toBe(300_000);
    expect(engageDuDossierPromo({ bcs, ordres: [{ montant: 200_000, statut: "PAID" }, { montant: 100_000, statut: "PENDING" }] })).toBe(200_000);
    // Un ordre annulé ne couvre rien ; un dépassement ne rend pas l'engagé négatif.
    expect(engageDuDossierPromo({ bcs, ordres: [{ montant: 200_000, statut: "CANCELLED" }] })).toBe(500_000);
    expect(engageDuDossierPromo({ bcs, ordres: [{ montant: 900_000, statut: "PAID" }] })).toBe(0);
    // Un ordre refusé par le centre ne paiera jamais : il ne couvre rien, le BC reste engagé (ARGENT-07).
    expect(engageDuDossierPromo({ bcs, ordres: [{ montant: 200_000, statut: "PENDING", centralStatus: "REFUSED" }] })).toBe(500_000);
  });
});

describe("qui impute, et sur quoi", () => {
  it("la Direction Marketing (principal ou secondaire) et le Super Admin", () => {
    expect(peutImputerMaterielPromo({ role: "PRODUCT_MANAGER" })).toBe(true);
    expect(peutImputerMaterielPromo({ role: "NATIONAL_SALES", secondaryRole: "PRODUCT_MANAGER" })).toBe(true);
    expect(peutImputerMaterielPromo({ role: "SUPER_ADMIN" })).toBe(true);
    for (const role of ["MEDICAL_DELEGATE", "FINANCE_BUDGET_MANAGER", "DIRECTION_ASSISTANT", "GENERAL_MANAGER"]) {
      expect(peutImputerMaterielPromo({ role }), role).toBe(false);
    }
  });
  it("une catégorie du Budget Marketing, sur un dossier vivant", () => {
    expect(refusImputationPromo({ dossierRefuse: false, cible: { id: "c", domaine: "MARKETING" }, actuelleId: null })).toBeNull();
    expect(refusImputationPromo({ dossierRefuse: false, cible: { id: "c", domaine: "GENERAL" }, actuelleId: null })).toMatch(/Budget Marketing/);
    expect(refusImputationPromo({ dossierRefuse: true, cible: { id: "c", domaine: "MARKETING" }, actuelleId: null })).toMatch(/refusé/);
    expect(refusImputationPromo({ dossierRefuse: false, cible: { id: "c", domaine: "MARKETING" }, actuelleId: "c" })).toMatch(/déjà/);
  });
});
