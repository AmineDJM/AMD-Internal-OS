import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Garde-fou de la migration `finance_rattache_adventum` : elle a été rejouée deux fois sur une base
 * PostgreSQL (PGlite) avec et sans entité Adventum ; ce test garantit qu'on n'y glisse pas, plus tard,
 * une écriture qui réécrirait l'historique d'une autre société ou supprimerait des lignes.
 */
const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20270113090000_finance_rattache_adventum/migration.sql"),
  "utf8",
).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("migration : tout l'existant de Banque & paiements rattaché à Adventum", () => {
  it("ne rattache que les lignes SANS entité (jamais une autre société)", () => {
    const updates = sql.match(/UPDATE\s+"\w+"\s+SET[^;]+;/g) ?? [];
    expect(updates).toHaveLength(3);
    for (const u of updates) expect(u).toMatch(/"companyId"\s+IS NULL/);
  });

  it("couvre les ordres de dépense, les comptes et le livre de trésorerie", () => {
    for (const t of ["ExpenseOrder", "TreasuryAccount", "FinanceTransaction"]) {
      expect(sql).toContain(`UPDATE "${t}"`);
    }
  });

  it("ne supprime rien et ne modifie aucun schéma", () => {
    expect(sql).not.toMatch(/\b(DELETE|DROP|TRUNCATE|ALTER)\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("ne fait rien (au lieu de deviner) quand Adventum n'existe pas", () => {
    expect(sql).toMatch(/IF adventum IS NULL THEN[\s\S]*RETURN/);
  });
});
