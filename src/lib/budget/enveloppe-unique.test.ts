import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LE CLIQUET — une enveloppe budgétaire ne naît QUE par `trouverOuCreerEnveloppe` (Super Admin, 25/11/2026).
 *
 * Les doublons de production (« Administration » ×2, « Operations & Sales 2026 » ×2) sont nés de créateurs qui
 * cherchaient chacun leur enveloppe à leur façon. Un `budgetEnvelope.create` (ou `createMany`, `upsert`, un
 * `INSERT INTO "BudgetEnvelope"`) écrit ailleurs dans le code de production rouvrirait la porte : la suite tombe, en
 * nommant le fichier. Les tests et les bancs hors `src/` (e2e, scripts/bench) créent leurs décors à la main : ils ne
 * tournent pas en production.
 */

const RACINE = join(__dirname, "..", "..", "..");
const PERMIS = new Set(["src/lib/budget/enveloppe-unique.ts"]);
const MOTIF = /budgetEnvelope\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(|INSERT\s+INTO\s+"BudgetEnvelope"/;

function fichiers(dossier: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dossier)) {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) {
      if (nom === "node_modules" || nom.startsWith(".")) continue;
      out.push(...fichiers(chemin));
    } else if (/\.(ts|tsx)$/.test(nom) && !/\.test\.tsx?$/.test(nom) && !/\.spec\.tsx?$/.test(nom)) {
      out.push(chemin);
    }
  }
  return out;
}

describe("une enveloppe ne naît que par la fonction unique", () => {
  it("aucun budgetEnvelope.create direct hors de enveloppe-unique.ts (src/ et prisma/*.ts)", () => {
    const candidats = [
      ...fichiers(join(RACINE, "src")),
      ...readdirSync(join(RACINE, "prisma")).filter((n) => /\.ts$/.test(n)).map((n) => join(RACINE, "prisma", n)),
    ];
    const fautes = candidats
      .map((f) => relative(RACINE, f).split("\\").join("/"))
      .filter((f) => !PERMIS.has(f) && MOTIF.test(readFileSync(join(RACINE, f), "utf8")));
    expect(fautes, "passer par trouverOuCreerEnveloppe (src/lib/budget/enveloppe-unique.ts), keyée par (société, direction, année)").toEqual([]);
  });

  it("le motif reconnaît bien les formes interdites", () => {
    for (const x of ["prisma.budgetEnvelope.create({", "tx.budgetEnvelope .upsert(", "db().budgetEnvelope.createMany(", 'INSERT INTO "BudgetEnvelope" ("id")']) expect(MOTIF.test(x), x).toBe(true);
    for (const x of ["prisma.budgetEnvelope.findMany({", "budgetCategoryLine.create("]) expect(MOTIF.test(x), x).toBe(false);
  });
});
