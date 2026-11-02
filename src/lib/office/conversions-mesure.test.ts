import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyserDocx, caracteresInterdits, mesurer, normaliserPourComparer, tauxErreurCaracteres, type Attendu } from "./conversions-mesure";

const CORPUS = path.join(process.cwd(), "scripts", "conversions", "corpus");
const attendu = JSON.parse(fs.readFileSync(path.join(CORPUS, "attendu.json"), "utf8")) as Record<string, Attendu>;

describe("mesure des conversions (décision 0019)", () => {
  it("repère chaque caractère interdit, et rien d'autre", () => {
    expect(caracteresInterdits("Texte propre — « ل » 3ᵉ ½ é")).toEqual([]);
    const codes = caracteresInterdits("a�b ﻻ ﬁ ‫x Ø§Ù„").map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["U+FFFD", "U+FEFB", "U+FB01", "U+202B", "mojibake"]));
  });

  it("le CER est 0 sur un texte identique (blancs et puces normalisés), et compte chaque erreur", () => {
    expect(tauxErreurCaracteres("Un  texte\n• puce", "Un texte puce")).toBe(0);
    expect(tauxErreurCaracteres("abcdefghij", "abcdefghiX")).toBeCloseTo(0.1);
    expect(normaliserPourComparer("l’ANPP")).toBe("l'ANPP");
  });

  it("le Word SOURCE du corpus arabe satisfait lui-même tous les critères (la mesure ne ment pas)", () => {
    const a = analyserDocx(fs.readFileSync(path.join(CORPUS, "ar-note.docx")));
    const m = mesurer(a, { ...attendu["ar-note.pdf"]!, images: [] });
    expect(m.cer).toBeLessThan(0.005);
    expect(m.interdits).toEqual([]);
    expect(m.rtl.paragraphesArabes).toBeGreaterThan(5);
    expect(m.rtl.justes).toBe(m.rtl.paragraphesArabes);
    expect(m.tableaux.justes).toBe(1);
    expect(a.images).toHaveLength(1);
  });
});
