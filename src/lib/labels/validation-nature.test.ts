import { describe, expect, it } from "vitest";
import { libelleNatureValidation, VALIDATION_OBJECT_TYPE } from "@/lib/labels";
import { OBJET_DECISION_INFO_MED } from "@/lib/medical-info/decideur";
import { OBJET_PREVALIDATION_BC } from "@/lib/bons-de-commande/prevalidation";
import { OBJET_DEPART_SALARIE } from "@/modules/rh/partage";

/**
 * LA NATURE D'UNE DEMANDE DE VALIDATION SE LIT EN CLAIR (recette sponsoring, 23/11/2026) : la carte du Directeur des
 * Opérations affichait « INFO_MED_DIRECTEUR_OPS ».
 */
describe("libelleNatureValidation", () => {
  it("les natures posées par le code ont un libellé français — jamais la clé brute", () => {
    // `OBJET_BC` vit dans un module serveur (aiguillage) : sa valeur est recopiée ici, comme dans la table.
    for (const code of [OBJET_DECISION_INFO_MED, OBJET_PREVALIDATION_BC, "BON_DE_COMMANDE", OBJET_DEPART_SALARIE]) {
      expect(VALIDATION_OBJECT_TYPE[code], code).toBeTruthy();
      expect(libelleNatureValidation(code)).not.toBe(code);
      expect(libelleNatureValidation(code)).not.toMatch(/_/);
    }
    expect(libelleNatureValidation(OBJET_DECISION_INFO_MED)).toBe("Décision du Directeur des Opérations");
  });

  it("une nature saisie à la main dans une règle s'affiche telle quelle ; rien → rien", () => {
    expect(libelleNatureValidation("Achat matériel")).toBe("Achat matériel");
    expect(libelleNatureValidation("  PREVALIDATION_BC  ")).toBe("Pré-validation d'un bon de commande");
    expect(libelleNatureValidation("")).toBeNull();
    expect(libelleNatureValidation("   ")).toBeNull();
    expect(libelleNatureValidation(null)).toBeNull();
    expect(libelleNatureValidation(undefined)).toBeNull();
  });
});
