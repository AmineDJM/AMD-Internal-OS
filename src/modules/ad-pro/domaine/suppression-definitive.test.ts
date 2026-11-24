import { describe, expect, it } from "vitest";
import {
  NATURES_SUPPRESSION_DEFINITIVE, REFUS_SOUS_VUE_EXACTE, REFUS_SUPPRESSION_DEFINITIVE, estNatureSuppressionDefinitive, referenceConfirmee,
  referenceDeLaDemande, refusSuppressionDefinitive,
} from "./suppression-definitive";

describe("suppression définitive d'une demande Ad & Pro — les règles", () => {
  it("le Super Admin réel, et lui seul", () => {
    expect(refusSuppressionDefinitive({ role: "SUPER_ADMIN" })).toBeNull();
    for (const role of ["GENERAL_MANAGER", "DIRECTION", "FINANCE_BUDGET_MANAGER", "OPERATIONS_DIRECTOR", "PRODUCT_MANAGER"]) {
      expect(refusSuppressionDefinitive({ role }), role).toBe(REFUS_SUPPRESSION_DEFINITIVE);
    }
  });

  it("jamais sous « Agir comme » / « Vue exacte » — même la personne incarnée Super Admin", () => {
    expect(refusSuppressionDefinitive({ role: "SUPER_ADMIN", impersonatedBy: { id: "sa", name: "SA", agir: true } })).toBe(REFUS_SOUS_VUE_EXACTE);
    expect(refusSuppressionDefinitive({ role: "DIRECTION", impersonatedBy: { id: "sa", name: "SA" } })).toBe(REFUS_SOUS_VUE_EXACTE);
  });

  it("les 5 natures et le matériel promotionnel — pas le consulting", () => {
    expect(Object.keys(NATURES_SUPPRESSION_DEFINITIVE).sort()).toEqual(["AD_PRO_OTHER", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "PROMO_MATERIAL", "SPONSORING"]);
    expect(estNatureSuppressionDefinitive("CONSULTING_CONTRACT")).toBe(false);
    expect(estNatureSuppressionDefinitive("toString")).toBe(false);
  });

  it("la référence : la sienne, sinon celle de la liste Ad & Pro (six derniers caractères de l'identifiant)", () => {
    expect(referenceDeLaDemande({ id: "cmabc123xyz789", reference: "SP-2026-014" })).toBe("SP-2026-014");
    expect(referenceDeLaDemande({ id: "cmabc123xyz789", reference: null })).toBe("XYZ789");
    expect(referenceDeLaDemande({ id: "cmabc123xyz789", reference: "  " })).toBe("XYZ789");
  });

  it("la référence retapée : espaces et casse pardonnés, un caractère de travers non, vide non", () => {
    expect(referenceConfirmee(" sp-2026-014 ", "SP-2026-014")).toBe(true);
    expect(referenceConfirmee("SP-2026-015", "SP-2026-014")).toBe(false);
    expect(referenceConfirmee("SP-2026-01", "SP-2026-014")).toBe(false);
    expect(referenceConfirmee("", "SP-2026-014")).toBe(false);
    expect(referenceConfirmee(null, "SP-2026-014")).toBe(false);
  });
});
