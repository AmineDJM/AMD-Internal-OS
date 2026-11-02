import { describe, it, expect } from "vitest";
import {
  employeeCosts, workforceMass, massByCompany, massProvenance, massIsIncomplete,
  type WorkforceEmployee, type WorkforcePayrollLine,
} from "./workforce-mass";

const emp = (o: Partial<WorkforceEmployee> & { id: string }): WorkforceEmployee => ({
  companyId: o.companyId ?? "adv",
  isActive: o.isActive ?? true,
  employerCost: o.employerCost ?? null,
  grossSalary: o.grossSalary ?? null,
  baseSalary: o.baseSalary ?? null,
  ...o,
});

const line = (employeeId: string, o: Partial<WorkforcePayrollLine> = {}): WorkforcePayrollLine => ({
  employeeId, employerCost: o.employerCost ?? null, gross: o.gross ?? null,
  bonuses: o.bonuses ?? null, deductions: o.deductions ?? null,
});

describe("le coût de chaque salarié", () => {
  it("SA LIGNE DE PAIE FAIT FOI, quel que soit l'état du pointage", () => {
    // C'était le premier chemin de la sous-estimation : on ne comptait que les lignes marquées
    // payées, et un mois saisi mais pas encore pointé valait zéro. La masse est un COÛT, pas un
    // décaissement — un bulletin en brouillon coûte déjà, le salaire est dû.
    const rows = employeeCosts([emp({ id: "a", employerCost: 100 })], [line("a", { employerCost: 180000 })]);
    expect(rows[0].cost).toBe(180000);
    expect(rows[0].source).toBe("PAYROLL");
  });

  it("SANS LIGNE, LE COÛT DE RÉFÉRENCE DE SA FICHE — un salarié ne disparaît pas du total", () => {
    // Deuxième chemin : le mois de référence était celui de la plateforme, si bien qu'une société
    // dont la paie n'était pas encore saisie tombait à zéro.
    const rows = employeeCosts([emp({ id: "a", employerCost: 150000 })], []);
    expect(rows[0].cost).toBe(150000);
    expect(rows[0].source).toBe("RECORD");
    expect(rows[0].basis).toBe("EMPLOYER_COST");
  });

  it("et le repli de la fiche suit son propre ordre : coût employeur, brut, salaire de base", () => {
    // Troisième chemin : on retombait directement sur le SALAIRE DE BASE, qui retire d'un coup
    // les primes ET les charges patronales.
    expect(employeeCosts([emp({ id: "a", grossSalary: 120000, baseSalary: 90000 })], [])[0]).toMatchObject({ cost: 120000, basis: "GROSS" });
    expect(employeeCosts([emp({ id: "a", baseSalary: 90000 })], [])[0]).toMatchObject({ cost: 90000, basis: "BASE_SALARY" });
  });

  it("SANS RIEN DU TOUT, ZÉRO — mais DIT, jamais lissé", () => {
    const rows = employeeCosts([emp({ id: "a" })], []);
    expect(rows[0]).toMatchObject({ cost: 0, source: "NONE", basis: "NONE" });
  });

  it("un salarié PARTI ne pèse plus — la société ne verse plus son salaire", () => {
    const rows = employeeCosts(
      [emp({ id: "a", employerCost: 100000 }), emp({ id: "b", isActive: false, employerCost: 999999 })],
      [line("b", { employerCost: 999999 })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeId).toBe("a");
  });

  it("une ligne sans coût employeur retombe sur brut + primes − retenues", () => {
    const rows = employeeCosts([emp({ id: "a" })], [line("a", { gross: 100000, bonuses: 20000, deductions: 5000 })]);
    expect(rows[0].cost).toBe(115000);
    expect(rows[0].basis).toBe("GROSS");
  });
});

describe("la masse de l'effectif", () => {
  const salaries = [
    emp({ id: "a", employerCost: 200000 }),
    emp({ id: "b", employerCost: 150000 }),
    emp({ id: "c", employerCost: 100000 }),
  ];

  it("COMPTE TOUT LE MONDE — c'est le total que la personne retrouve en additionnant à la main", () => {
    const m = workforceMass(employeeCosts(salaries, [line("a", { employerCost: 210000 })]));
    expect(m.total).toBe(210000 + 150000 + 100000);
    expect(m.fromPayroll).toBe(1);
    expect(m.fromRecord).toBe(2);
    expect(m.uncovered).toBe(0);
    expect(m.basis).toBe("EMPLOYER_COST");
  });

  it("la base est celle du LOT : un seul brut suffit à ne plus dire « coût employeur »", () => {
    const m = workforceMass(employeeCosts([...salaries, emp({ id: "d", grossSalary: 90000 })], []));
    expect(m.basis).toBe("GROSS");
  });

  it("un effectif vide ne prétend rien", () => {
    const m = workforceMass([]);
    expect(m).toMatchObject({ total: 0, basis: "NONE", uncovered: 0 });
  });

  it("CE QUI MANQUE SE COMPTE ET SE DIT", () => {
    const m = workforceMass(employeeCosts([...salaries, emp({ id: "e" })], []));
    expect(m.uncovered).toBe(1);
    expect(massIsIncomplete(m)).toBe(true);
    expect(massProvenance(m)).toMatch(/1 sans montant connu/);
    expect(massProvenance(m)).toMatch(/3 d'après la fiche salarié/);
  });

  it("une masse complète le dit aussi, sans alerte", () => {
    const m = workforceMass(employeeCosts(salaries, salaries.map((e) => line(e.id, { employerCost: 100 }))));
    expect(massIsIncomplete(m)).toBe(false);
    expect(massProvenance(m)).toBe("3 d'après la paie du mois");
  });
});

describe("la masse par entité", () => {
  it("CHAQUE SOCIÉTÉ RECONNAÎT SON CHIFFRE — un total mélangé n'est celui d'aucune", () => {
    const rows = employeeCosts(
      [
        emp({ id: "a", companyId: "adv", employerCost: 200000 }),
        emp({ id: "b", companyId: "adv", employerCost: 150000 }),
        emp({ id: "c", companyId: "pha", employerCost: 300000 }),
        emp({ id: "d", companyId: null, employerCost: 50000 }),
      ],
      [],
    );
    const parEntite = massByCompany(rows);
    expect(parEntite.get("adv")?.total).toBe(350000);
    expect(parEntite.get("pha")?.total).toBe(300000);
    // Un salarié SANS entité forme son propre groupe, nommé : c'est lui qu'il faut rattacher.
    expect(parEntite.get(null)?.total).toBe(50000);
  });

  it("et la provenance se lit entité par entité", () => {
    const rows = employeeCosts(
      [emp({ id: "a", companyId: "adv", employerCost: 100 }), emp({ id: "b", companyId: "pha" })],
      [line("a", { employerCost: 100 })],
    );
    const parEntite = massByCompany(rows);
    expect(parEntite.get("adv")?.fromPayroll).toBe(1);
    expect(parEntite.get("pha")?.uncovered).toBe(1);
  });
});
