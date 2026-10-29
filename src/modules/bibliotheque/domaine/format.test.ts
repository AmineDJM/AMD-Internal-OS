import { describe, expect, it } from "vitest";
import { extensionPourLecture, formatDe, plier, titreDe } from "./format";

describe("Format, titre, repli", () => {
  it("l'extension décide avant le type annoncé", () => {
    expect(formatDe("Contrat.PDF", "application/octet-stream")).toBe("pdf");
    expect(formatDe("bilan.xlsx", null)).toBe("tableur");
    expect(formatDe("note", "text/plain")).toBe("texte");
    expect(formatDe("vocal", "audio/webm")).toBe("audio");
    expect(formatDe("archive.7z", null)).toBe("archive");
    expect(formatDe("inconnu", null)).toBe("autre");
  });
  it("donne aux lecteurs l'extension du nom, sinon celle du type", () => {
    expect(extensionPourLecture("scan", "image/jpeg")).toBe("jpg");
    expect(extensionPourLecture("devis.docx", "application/pdf")).toBe("docx");
  });
  it("replie les accents et la casse", () => {
    expect(plier("Règlement  Intérieur_ÉTÉ")).toBe("reglement interieur ete");
  });
  it("le titre est le nom sans extension, lisible", () => {
    expect(titreDe("contrat_de_travail_2026.pdf")).toBe("contrat de travail 2026");
    expect(titreDe("   ")).toBe("Sans titre");
  });
});
