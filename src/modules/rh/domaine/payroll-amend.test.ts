import { describe, it, expect } from "vitest";
import { validateAmounts, resolvedGross, amendImpact, canAmend } from "./payroll-amend";

describe("validateAmounts — les trois règles d'un bulletin", () => {
  it("accepte une ligne cohérente", () => {
    expect(validateAmounts({ employerCost: 120_000, net: 80_000, gross: 100_000 })).toBeNull();
  });

  it("exige le coût employeur — c'est lui qui pèse sur le budget", () => {
    expect(validateAmounts({ employerCost: null, net: 80_000, gross: null })).toContain("coût employeur");
    expect(validateAmounts({ employerCost: 0, net: 80_000, gross: null })).toContain("coût employeur");
  });

  it("exige le net — c'est ce que voit le salarié", () => {
    expect(validateAmounts({ employerCost: 120_000, net: null, gross: null })).toContain("net");
  });

  it("refuse un net supérieur au coût employeur", () => {
    expect(validateAmounts({ employerCost: 100_000, net: 110_000, gross: null })).toContain("dépasser");
  });

  // Les charges patronales s'AJOUTENT au brut : un brut supérieur au coût employeur est
  // arithmétiquement impossible, et signale une inversion de champs à la saisie.
  it("refuse un brut supérieur au coût employeur", () => {
    expect(validateAmounts({ employerCost: 100_000, net: 80_000, gross: 120_000 })).toContain("charges patronales");
  });

  it("tolère un brut absent ou nul — c'est une ligne de bulletin, pas une base de calcul", () => {
    expect(validateAmounts({ employerCost: 100_000, net: 80_000, gross: null })).toBeNull();
    expect(validateAmounts({ employerCost: 100_000, net: 80_000, gross: 0 })).toBeNull();
  });
});

describe("resolvedGross — jamais un brut à zéro", () => {
  it("garde le brut saisi", () => {
    expect(resolvedGross({ employerCost: 120_000, net: 80_000, gross: 100_000 })).toBe(100_000);
  });

  // Une ligne à brut nul se lit comme une paie nulle, et fausse tous les états qui retombent
  // sur le brut faute de coût employeur.
  it("retombe sur le coût employeur plutôt que sur 0", () => {
    expect(resolvedGross({ employerCost: 120_000, net: 80_000, gross: null })).toBe(120_000);
    expect(resolvedGross({ employerCost: 120_000, net: 80_000, gross: 0 })).toBe(120_000);
  });
});

describe("amendImpact — ce que la correction déplace, budget compris", () => {
  const before = { employerCost: 120_000, net: 80_000 };

  it("mesure l'écart de coût employeur", () => {
    expect(amendImpact(before, { employerCost: 130_000, net: 80_000 }, { transferred: false }).delta).toBe(10_000);
    expect(amendImpact(before, { employerCost: 110_000, net: 80_000 }, { transferred: false }).delta).toBe(-10_000);
  });

  // LE POINT : après transfert, la correction doit suivre jusqu'à l'écriture de trésorerie,
  // sinon la paie dit un montant et le budget en dit un autre.
  it("demande la reprise du budget quand le montant change ET que la ligne est transférée", () => {
    expect(amendImpact(before, { employerCost: 130_000, net: 80_000 }, { transferred: true }).syncBudget).toBe(true);
  });

  it("ne touche PAS au budget quand seul le net change", () => {
    expect(amendImpact(before, { employerCost: 120_000, net: 75_000 }, { transferred: true }).syncBudget).toBe(false);
  });

  // Rejouer l'écriture pour rien ferait apparaître un mouvement de trésorerie là où il n'y en
  // a pas eu.
  it("ne touche pas au budget sur une ligne non transférée", () => {
    expect(amendImpact(before, { employerCost: 130_000, net: 80_000 }, { transferred: false }).syncBudget).toBe(false);
  });

  it("résume ce qui a bougé, en clair", () => {
    const s = amendImpact(before, { employerCost: 130_000, net: 75_000 }, { transferred: false }).summary;
    expect(s).toContain("coût employeur");
    expect(s).toContain("net");
  });

  it("dit quelque chose même quand aucun montant ne change", () => {
    expect(amendImpact(before, { ...before }, { transferred: false }).summary).toBe("pièces et mentions corrigées");
  });
});

describe("canAmend — on corrige une paie faite, pas un brouillon", () => {
  // Refuser après le transfert, c'est garantir qu'on vit avec un chiffre faux : personne ne
  // défera un transfert de paie pour mille dinars.
  it("accepte une ligne payée ou transférée", () => {
    for (const status of ["PAID", "TRANSFERRED", "VALIDATED"]) {
      expect(canAmend({ status }).ok, status).toBe(true);
    }
  });

  it("refuse un brouillon, en disant quoi faire à la place", () => {
    const r = canAmend({ status: "DRAFT" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("marquez-la payée");
  });
});
