import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildBudgetWorkbook, budgetExportFilename } from "@/lib/budget-export";
import type { BudgetOverview, EnvelopesGrandTotal, BudgetCategoryView } from "@/lib/queries/budget";

/**
 * Export Excel du budget : vraie feuille .xlsx (relue par SheetJS), avec le TAUX DE
 * CONSOMMATION par catégorie et une feuille « Total enveloppes ».
 */

const cat = (over: Partial<BudgetCategoryView>): BudgetCategoryView => ({
  id: "c", name: "Cat", module: null, parentId: null, color: null, notes: null,
  allocated: 0, consumed: 0, committed: 0, remaining: 0, pct: 0, health: "NONE", ...over,
});

const overview: BudgetOverview = {
  envelope: { id: "e1", name: "Budget 2026", module: null, modules: ["SPONSORING"], accessRoles: [], accessUserIds: [], managerRoles: [], managerUserIds: [], periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-12-31T00:00:00.000Z", total: 1000, notes: null, isActive: true, domaine: "GENERAL", businessUnitId: null, productId: null },
  period: { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" },
  categories: [
    cat({ id: "a", name: "Promotion", module: "SPONSORING", allocated: 1000, consumed: 800, remaining: 200, pct: 80 }),
    cat({ id: "b", name: "Table ronde", parentId: "a", allocated: 400, consumed: 400, remaining: 0, pct: 100 }),
  ],
  totals: { total: 1000, allocated: 1000, unallocated: 0, consumed: 800, committed: 0, remaining: 200, pct: 80 },
  monthly: [],
  unattributed: { total: 0, count: 0, transactions: [] },
  attributed: { count: 0, transactions: [] },
};

const grand: EnvelopesGrandTotal = {
  count: 1, total: 1000, allocated: 1000, consumed: 800, remaining: 200,
  items: [{ id: "e1", name: "Budget 2026", societe: null, isActive: true, modules: ["SPONSORING"], domaine: "GENERAL", total: 1000, allocated: 1000, consumed: 800, remaining: 200 }],
};

describe("buildBudgetWorkbook", () => {
  it("produit un .xlsx relisible, avec catégories + TAUX DE CONSOMMATION + feuille total", () => {
    const buf = buildBudgetWorkbook(overview, grand);
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toContain("Enveloppe");
    expect(wb.SheetNames).toContain("Total enveloppes");

    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["Enveloppe"], { header: 1 });
    const header = rows.find((r) => r[0] === "Catégorie")!;
    expect(header).toContain("Taux consommation (%)");
    // Ligne « Promotion » : consommé 800 / alloué 1000 → 80 %.
    const promo = rows.find((r) => r[0] === "Promotion")!;
    expect(promo).toBeTruthy();
    expect(promo[3]).toBe(1000); // alloué
    expect(promo[4]).toBe(800); // consommé
    expect(promo[7]).toBe(80); // taux de consommation
    // La sous-catégorie référence sa catégorie parente.
    const sub = rows.find((r) => r[0] === "Table ronde")!;
    expect(sub[1]).toBe("Promotion");

    // Feuille total : ligne TOTAL avec le taux global.
    const gRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["Total enveloppes"], { header: 1 });
    const total = gRows.find((r) => r[0] === "TOTAL")!;
    expect(total[6]).toBe(80);
  });

  it("nom de fichier assaini + daté", () => {
    expect(budgetExportFilename("Budget 2026 / Ops")).toMatch(/^budget-Budget-2026-Ops-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
