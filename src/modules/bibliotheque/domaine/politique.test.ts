import { describe, expect, it } from "vitest";
import { exclusionPourModele, plusStricte, vectorisable } from "./politique";

describe("Ce qui part à un modèle", () => {
  it("une pièce confidentielle ou sensible ne part pas ; une pièce interne, si", () => {
    expect(exclusionPourModele({ confidentiality: "CONFIDENTIAL", sensible: false })).toBe("CONFIDENTIELLE");
    expect(exclusionPourModele({ confidentiality: "INTERNAL", sensible: true })).toBe("SENSIBLE");
    expect(exclusionPourModele({ confidentiality: "RESTRICTED", sensible: false })).toBeNull();
  });
  it("le texte d'une pièce exclue n'est jamais envoyé au fournisseur d'embeddings", () => {
    expect(vectorisable({ confidentiality: "CONFIDENTIAL", sensible: false })).toBe(false);
    expect(vectorisable({ confidentiality: "INTERNAL", sensible: true })).toBe(false);
    expect(vectorisable({ confidentiality: "INTERNAL", sensible: false })).toBe(true);
  });
  it("une pièce rangée à deux endroits garde la confidentialité la plus stricte", () => {
    expect(plusStricte("INTERNAL", "CONFIDENTIAL")).toBe("CONFIDENTIAL");
    expect(plusStricte("RESTRICTED", "INTERNAL")).toBe("RESTRICTED");
  });
});
