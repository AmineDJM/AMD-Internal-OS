import { describe, expect, it } from "vitest";
import { celluleCsv, neutraliserFormuleCsv } from "./csv-cellule";
import { ecrireCsv } from "./tableur";
import { versCsv as versCsvAnalyse } from "@/platform/ia/analyse/affichage";
import { versCsv as versCsvConsommation } from "@/modules/assistant-ia/partage";
import { csvDepensesMarketing } from "@/lib/budget-export";
import { rendreCsv } from "@/lib/missions/artifacts/render";

/**
 * AUDIT DRIVE F15 — une saisie ne devient jamais une FORMULE dans le tableur de qui ouvre un export CSV.
 */

const PIEGES = ["=HYPERLINK(\"http://x\";\"y\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\r=1"];

describe("neutraliserFormuleCsv / celluleCsv", () => {
  it("préfixe d'une apostrophe tout texte qui commencerait une formule", () => {
    for (const p of PIEGES) expect(neutraliserFormuleCsv(p), JSON.stringify(p)).toBe(`'${p}`);
    expect(neutraliserFormuleCsv("Alger")).toBe("Alger");
    expect(neutraliserFormuleCsv("a=b")).toBe("a=b");
  });
  it("un NOMBRE reste un nombre (un montant négatif n'est pas une formule)", () => {
    expect(celluleCsv(-12.5)).toBe("-12.5");
    expect(celluleCsv("-12.5")).toBe("'-12.5");
  });
  it("échappe guillemets, séparateur et sauts de ligne", () => {
    expect(celluleCsv('a;"b"')).toBe('"a;""b"""');
    expect(celluleCsv("a,b", { separateur: "," })).toBe('"a,b"');
    expect(celluleCsv("x", { guillemets: "toujours" })).toBe('"x"');
    expect(celluleCsv(null)).toBe("");
    expect(celluleCsv("\r=1")).toBe(`"'\r=1"`);
  });
});

describe("tous les exports CSV passent par la neutralisation", () => {
  const sansFormule = (csv: string) => csv.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap((l) => l.split(/[;,]/))
    .map((c) => c.replace(/^"/, "")).filter((c) => /^[=+@]/.test(c));
  it("ecrireCsv (tableur)", () => {
    expect(sansFormule(ecrireCsv([{ nom: "=1+1", n: -3 }]).texte)).toEqual([]);
    expect(ecrireCsv([{ n: -3 }]).texte).toContain("-3");
  });
  it("analyse de l'assistant (écran et serveur)", () => {
    const csv = versCsvAnalyse([{ libelle: "@titre" } as never], [["=1+1"], [-4]]);
    expect(sansFormule(csv)).toEqual([]);
    expect(csv).toContain("-4");
  });
  it("consommation de l'assistant", () => {
    expect(sansFormule(versCsvConsommation([["+cmd", 2]]))).toEqual([]);
  });
  it("dépenses du budget Marketing", () => {
    const csv = csvDepensesMarketing([{ date: "2026-11-24", reference: "=x", libelle: "@y", categorie: "+z", nature: "n", demande: "d", origine: "o", montant: -5 } as never]);
    expect(sansFormule(csv)).toEqual([]);
    expect(csv).toContain("-5,00");
  });
  it("artefacts des missions", () => {
    const csv = rendreCsv({ sheets: [{ columns: [{ key: "a", header: "A" }], rows: [{ a: "=2*3" }] }] } as never).toString("utf8");
    expect(sansFormule(csv)).toEqual([]);
  });
});
