import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { convertirHauteFidelite, etatMoteur, noteDuBilan, pythonDuMoteur } from "./conversions-haute-fidelite";
import { analyserDocx, mesurer, type Attendu } from "./conversions-mesure";

/**
 * LE SOUS-ENSEMBLE RAPIDE du banc (`npm run conversions:bench`) : deux PDF du corpus, numériques (≈ 1 s chacun).
 * Il tourne là où le moteur est complet (image du worker, poste avec `CONVERSIONS_PYTHON`) ; ailleurs il est sauté,
 * et le dit.
 */
const CORPUS = path.join(process.cwd(), "scripts", "conversions", "corpus");
const attendu = JSON.parse(fs.readFileSync(path.join(CORPUS, "attendu.json"), "utf8")) as Record<string, Attendu>;
let pret = false;

beforeAll(async () => {
  const e = await etatMoteur(true);
  pret = e.pret;
  if (!pret) console.info(`[conversions] moteur absent ici (${e.manquants.join(", ") || e.erreur}) : sous-ensemble sauté`);
}, 60_000);

describe("moteur haute fidélité — PDF → Word (décision 0019)", () => {
  for (const fichier of ["ar-note.pdf", "mixte-ar-fr.pdf"]) {
    it(`${fichier} : CER ≤ 1 %, images, 0 interdit, RTL, tableaux`, async (ctx) => {
      if (!pret) ctx.skip();
      const r = await convertirHauteFidelite(fs.readFileSync(path.join(CORPUS, fichier)), "PDF", "DOCX");
      const m = mesurer(analyserDocx(r.octets), attendu[fichier]!);
      expect(m.cer).toBeLessThanOrEqual(0.01);
      expect(m.interdits).toEqual([]);
      expect(m.images.dimensionsJustes).toBe(m.images.attendues);
      expect(m.rtl.justes).toBe(m.rtl.paragraphesArabes);
      expect(m.tableaux.justes).toBe(m.tableaux.attendus.length);
      expect(noteDuBilan("PDF", "DOCX", r.bilan)).toMatch(/reconstruite/);
    }, 120_000);
  }
});

describe("moteur haute fidélité — normalisation et ordre logique (tests Python purs)", () => {
  it("scripts/conversions/tests : tous verts", (ctx) => {
    if (!pret) ctx.skip();
    const sortie = execFileSync(pythonDuMoteur(), ["-m", "unittest", "discover", "-s", "scripts/conversions/tests"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(sortie).toBeDefined();
  }, 60_000);
});
