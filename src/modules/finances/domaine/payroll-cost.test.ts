import { describe, it, expect } from "vitest";
import { entryCost, entryBasis, basisLabel, defaultEmployerCost } from "./payroll-cost";

describe("entryCost — le coût employeur est un TOTAL, pas une base", () => {
  it("le coût employeur se suffit : primes et retenues sont déjà dedans", () => {
    // 120 000, et non 120 000 + 10 000 − 5 000 : les compter deux fois gonflerait la masse.
    expect(entryCost({ employerCost: 120_000, gross: 100_000, bonuses: 10_000, deductions: 5_000 })).toBe(120_000);
  });

  it("sans coût employeur : brut + primes − retenues", () => {
    expect(entryCost({ gross: 100_000, bonuses: 10_000, deductions: 5_000 })).toBe(105_000);
  });

  it("un coût employeur à zéro est une VALEUR, pas une absence", () => {
    expect(entryCost({ employerCost: 0, gross: 100_000 })).toBe(0);
  });

  it("les champs manquants valent zéro, sans faire NaN", () => {
    expect(entryCost({})).toBe(0);
    expect(entryCost({ gross: null, bonuses: undefined })).toBe(0);
  });
});

describe("entryBasis", () => {
  it("dit « coût employeur » quand il est saisi", () => {
    expect(entryBasis({ employerCost: 120_000 })).toBe("EMPLOYER_COST");
  });

  it("dit « brut » quand on retombe dessus", () => {
    expect(entryBasis({ gross: 100_000 })).toBe("GROSS");
  });

  it("dit « aucune donnée » quand il n'y a rien", () => {
    expect(entryBasis({})).toBe("NONE");
  });
});

describe("basisLabel", () => {
  it("nomme chaque base en clair", () => {
    expect(basisLabel("EMPLOYER_COST")).toBe("coût employeur");
    expect(basisLabel("GROSS")).toContain("brut");
    expect(basisLabel("BASE_SALARY")).toContain("salaires de base");
    expect(basisLabel("NONE")).toBe("aucune donnée");
  });
});

describe("defaultEmployerCost — jamais un zéro préinscrit", () => {
  it("préfère le coût employeur de la fiche", () => {
    expect(defaultEmployerCost({ employerCost: 150_000, grossSalary: 120_000, baseSalary: 100_000 })).toBe(150_000);
  });

  it("retombe sur le brut, puis sur le salaire de base", () => {
    expect(defaultEmployerCost({ grossSalary: 120_000, baseSalary: 100_000 })).toBe(120_000);
    expect(defaultEmployerCost({ baseSalary: 100_000 })).toBe(100_000);
  });

  // Un zéro préinscrit dans un champ obligatoire se valide sans qu'on le relise.
  it("rend `null` plutôt que 0 quand rien n'est renseigné", () => {
    expect(defaultEmployerCost({})).toBeNull();
    expect(defaultEmployerCost({ employerCost: 0, grossSalary: 0, baseSalary: 0 })).toBeNull();
  });
});
