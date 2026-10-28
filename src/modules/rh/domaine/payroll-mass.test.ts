import { describe, it, expect } from "vitest";
import {
  massByDepartment, budgetRefreshes, refreshSummary, type PayrollCostLine,
} from "./payroll-mass";

const l = (departmentId: string | null, companyId: string | null, cost: number): PayrollCostLine =>
  ({ departmentId, companyId, cost });

const dzd = (n: number) => `${n} DZD`;

describe("la masse salariale par département", () => {
  it("ADDITIONNE LES COÛTS EMPLOYEUR, département par département", () => {
    const r = massByDepartment([l("d1", "adv", 100), l("d1", "adv", 50), l("d2", "pha", 80)]);
    expect(r.byDepartment.get("d1")).toBe(150);
    expect(r.byDepartment.get("d2")).toBe(80);
    expect(r.total).toBe(230);
  });

  it("ÉCARTE LES LIGNES SANS DÉPARTEMENT, et les CHIFFRE", () => {
    // Les imputer à un département arbitraire fausserait son budget ; les répartir au prorata
    // inventerait un chiffre. On les nomme pour qu'on puisse les rattacher.
    const r = massByDepartment([l("d1", "adv", 100), l(null, "adv", 40)]);
    expect(r.byDepartment.get("d1")).toBe(100);
    expect(r.byDepartment.has("")).toBe(false);
    expect(r.unassigned).toBe(40);
    expect(r.total, "elles comptent dans le total du groupe").toBe(140);
  });

  it("une paie vide ne fabrique aucun département", () => {
    const r = massByDepartment([]);
    expect(r.byDepartment.size).toBe(0);
    expect(r.total).toBe(0);
  });
});

describe("actualiser le budget, ne pas y ajouter", () => {
  it("REMPLACE : le montant écrit est la masse CALCULÉE, jamais l'ancien plus quelque chose", () => {
    // C'est tout le sujet : incrémenter suppose de ne jamais transférer deux fois, de ne jamais
    // corriger une ligne, de ne jamais annuler un paiement. Les trois arrivent.
    const r = budgetRefreshes(new Map([["d1", 150]]), new Map([["d1", 120]]));
    expect(r).toEqual([{ departmentId: "d1", amount: 150, was: 120 }]);
  });

  it("EST IDEMPOTENT : rejouer le même transfert n'écrit RIEN", () => {
    expect(budgetRefreshes(new Map([["d1", 150]]), new Map([["d1", 150]]))).toEqual([]);
  });

  it("UN DÉPARTEMENT SANS SALARIÉ PAYÉ REVIENT À ZÉRO — il ne disparaît pas", () => {
    // Laisser l'ancien montant afficherait une masse salariale sur une équipe dissoute.
    const r = budgetRefreshes(new Map(), new Map([["d1", 90]]));
    expect(r).toEqual([{ departmentId: "d1", amount: 0, was: 90 }]);
  });

  it("un département nouvellement peuplé s'écrit depuis zéro", () => {
    expect(budgetRefreshes(new Map([["d2", 40]]), new Map())).toEqual([{ departmentId: "d2", amount: 40, was: 0 }]);
  });

  it("le plus gros mouvement vient en tête — le journal se lit de haut en bas", () => {
    const r = budgetRefreshes(new Map([["a", 10], ["b", 300]]), new Map());
    expect(r.map((x) => x.departmentId)).toEqual(["b", "a"]);
  });
});

describe("ce que le journal retient", () => {
  it("dit le REMPLACEMENT, pour qu'on ne le lise pas comme une addition", () => {
    const msg = refreshSummary([{ departmentId: "d1", amount: 150, was: 120 }], dzd);
    expect(msg).toContain("150 DZD");
    expect(msg).toMatch(/remplacement/i);
  });

  it("et se contente d'une phrase quand rien ne bouge", () => {
    expect(refreshSummary([], dzd)).toMatch(/inchangée/i);
  });
});
