import { describe, it, expect } from "vitest";
import { reparerNomDeFichier } from "./nom-de-fichier";

describe("reparerNomDeFichier — un nom lu en latin-1 à l'envoi, relu en UTF-8 (recette 21/11/2026)", () => {
  it("le papier en-tête de la production : « e » + circonflexe séparé, abîmé en « Ì\\u0082 »", () => {
    expect(reparerNomDeFichier("Adventum_en_TeÌ\u0082te_Word (1).docx")).toBe("Adventum_en_Tête_Word (1).docx");
    expect(reparerNomDeFichier("Excel_en-teÌ\u0082te_ADVENTUM.xlsx")).toBe("Excel_en-tête_ADVENTUM.xlsx");
  });

  it("un accent composé abîmé (« Ã© », « Ã§ ») redevient lui-même", () => {
    expect(reparerNomDeFichier("ReÃ§u_dÃ©claration.pdf")).toBe("Reçu_déclaration.pdf");
  });

  it("un nom sain revient tel quel — accents d'origine compris, recomposés", () => {
    expect(reparerNomDeFichier("Template_ADVENTUM_PPT.pptx")).toBe("Template_ADVENTUM_PPT.pptx");
    expect(reparerNomDeFichier("Facture été 2026 — Atlas.pdf")).toBe("Facture été 2026 — Atlas.pdf");
    expect(reparerNomDeFichier("Tête.docx")).toBe("Tête.docx");
  });

  it("une suite qui ressemble à la signature sans être de l'UTF-8 n'est pas touchée", () => {
    // « Ã\u0080 » a la signature, mais l'octet C3 qui suit, seul, n'est pas de l'UTF-8 : le nom revient tel quel.
    expect(reparerNomDeFichier("Ã\u0080Ã.txt")).toBe("Ã\u0080Ã.txt".normalize("NFC"));
  });
});
