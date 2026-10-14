import { describe, it, expect } from "vitest";
import { natureApercu, ouvrableDansLEditeur, apercuPossible, EXTENSIONS_CONVERTIBLES, extensionDe } from "./apercu";

describe("quel aperçu pour quel fichier — une table pour tous les écrans", () => {
  it("les anciens formats Office ne sont plus « non disponibles » : ils s'ouvrent dans l'éditeur", () => {
    for (const nom of ["rapport.doc", "note.RTF", "tableau.xls", "deck.ppt", "lettre.odt", "feuille.ods", "pres.odp", "livre.epub", "cv.pages", "bilan.numbers", "ancien.pps"]) {
      expect(natureApercu(nom), nom).toBe("converti");
    }
  });

  it("les formats modernes gardent leur visionneuse dans le navigateur", () => {
    expect(natureApercu("a.docx")).toBe("docx");
    expect(natureApercu("a.xlsx")).toBe("xlsx");
    expect(natureApercu("a.csv")).toBe("xlsx");
    expect(natureApercu("a.pptx")).toBe("pptx");
    expect(natureApercu("a.pdf")).toBe("pdf");
    expect(natureApercu("a.zip")).toBe("zip");
  });

  it("images, vidéos, sons et textes (code, journaux, JSON, YAML, SQL, Markdown) s'affichent", () => {
    expect(natureApercu("a.WEBP")).toBe("image");
    expect(natureApercu("a.mp4")).toBe("video");
    expect(natureApercu("a.flac")).toBe("audio");
    for (const nom of ["a.log", "a.json", "a.yml", "a.sql", "a.md", "a.py", "a.ts", "a.toml", "a.srt"]) expect(natureApercu(nom), nom).toBe("texte");
    expect(natureApercu("page.html")).toBe("html");
  });

  it("à défaut d'extension connue, le type MIME tranche", () => {
    expect(natureApercu("sans-extension", "image/png")).toBe("image");
    expect(natureApercu("export", "text/plain")).toBe("texte");
    expect(natureApercu("export", "text/html")).toBe("html");
    expect(natureApercu("export", "application/pdf")).toBe("pdf");
    expect(natureApercu("export", "application/json")).toBe("texte");
  });

  it("Word, Excel, PowerPoint et les anciens formats s'ouvrent dans l'ÉDITEUR OFFICE, sur le serveur (PC des utilisateurs limités)", () => {
    for (const nom of ["a.docx", "a.xlsx", "a.csv", "a.pptx", "a.doc", "a.rtf", "a.xls", "a.ppt", "a.odt"]) expect(ouvrableDansLEditeur(nom), nom).toBe(true);
    // Ce que le navigateur lit seul n'a aucune raison de passer par une conversion.
    for (const nom of ["a.pdf", "a.png", "a.mp4", "a.txt", "a.zip", "a.exe"]) expect(ouvrableDansLEditeur(nom), nom).toBe(false);
  });

  it("un binaire inconnu n'a pas d'aperçu : on propose le téléchargement, jamais une page blanche", () => {
    expect(natureApercu("setup.exe")).toBe("autre");
    expect(apercuPossible("setup.exe")).toBe(false);
    expect(apercuPossible("a.doc")).toBe(true);
  });

  it("la liste des convertibles est celle que la nature annonce — rien n'est oublié ni en double", () => {
    expect(new Set(EXTENSIONS_CONVERTIBLES).size).toBe(EXTENSIONS_CONVERTIBLES.length);
    for (const e of EXTENSIONS_CONVERTIBLES) expect(natureApercu(`x.${e}`), e).toBe("converti");
    expect(extensionDe("archive.tar.GZ")).toBe("gz");
  });
});

describe("visionneuseDeSecours — les modèles OOXML se lisent aussi sans l'éditeur", () => {
  it("donne la visionneuse Word aux modèles et variantes de Word", async () => {
    const { visionneuseDeSecours } = await import("./apercu");
    expect(visionneuseDeSecours("Attestation de travail AMINE DJOUMAI.dotx")).toBe("docx");
    expect(visionneuseDeSecours("rapport.docm")).toBe("docx");
    expect(visionneuseDeSecours("budget.xltx")).toBe("xlsx");
    expect(visionneuseDeSecours("ancien.xls")).toBe("xlsx");
    expect(visionneuseDeSecours("charte.potx")).toBe("pptx");
    expect(visionneuseDeSecours("vieux.doc")).toBeNull();
    expect(visionneuseDeSecours("note.odt")).toBeNull();
  });
});
