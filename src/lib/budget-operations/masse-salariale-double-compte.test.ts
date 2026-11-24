import { describe, expect, it } from "vitest";
import { coutNetMasseSalariale, entryCost, ordreHorsBudget, ventilationBudgetaire } from "@/modules/finances/partage";
import { HORS_BU, imputerPaie } from "./force-de-vente";

/**
 * AUCUN DOUBLE COMPTE (contrôle final, 24/11/2026 — décision du Super Admin) :
 *   · la masse salariale d'un budget = net + primes, IRG (`MS_IRG`), CNAS (`MS_CNAS`) ; leur total = le coût employeur.
 *     La paie consomme la ligne « masse salariale » au NET + primes ; l'IRG et la CNAS y arrivent par Impôts & cotisations.
 *   · une avance sur salaire est de la trésorerie : elle n'est pas une charge (la paie qui la reprend l'est déjà).
 */

// Un salarié, un mois : net versé 100 000 (primes 10 000 comprises), IRG 20 000, CNAS 9 000 + 21 000 → coût employeur 150 000.
const LIGNE = { employerCost: 150_000, net: 100_000, gross: 120_000, bonuses: 10_000, deductions: 30_000 };

describe("la masse salariale : net + primes, IRG, CNAS — et rien deux fois", () => {
  it("la ligne de paie consomme le NET + primes, pas le coût employeur", () => {
    expect(coutNetMasseSalariale(LIGNE)).toBe(100_000);
    expect(entryCost(LIGNE)).toBe(150_000);
  });

  it("sans net saisi : brut + primes − retenues salariales ; jamais négatif", () => {
    expect(coutNetMasseSalariale({ gross: 120_000, bonuses: 10_000, deductions: 30_000 })).toBe(100_000);
    expect(coutNetMasseSalariale({ net: 0, gross: 0, deductions: 5_000 })).toBe(0);
  });

  it("paie (net + primes) + G50 (IRG → MS_IRG) + bordereau CNAS (→ MS_CNAS) = le coût employeur, une seule fois", () => {
    const cat = { id: "ms", envelopeId: "env", businessUnitId: null, debut: new Date("2026-01-01"), fin: new Date("2026-12-31"), companyId: null };
    const paie = imputerPaie(
      [{ employeeId: "e1", year: 2026, month: 3, cost: coutNetMasseSalariale(LIGNE), companyId: null }],
      new Map([["e1", HORS_BU]]), [cat],
    );
    const consommeParLaPaie = paie.parCategorie.get("ms") ?? 0;
    const g50 = ventilationBudgetaire("G50", [{ cle: "irg", montant: 20_000 }, { cle: "tva", montant: 0 }], "G50", "Recette des impôts");
    const cnas = ventilationBudgetaire("CNAS", [{ cle: "sal", montant: 9_000 }, { cle: "pat", montant: 21_000 }], "Cotisations", "CNAS");
    expect(g50).toEqual([{ cle: "MS_IRG", montant: 20_000 }]);
    expect(cnas).toEqual([{ cle: "MS_CNAS", montant: 30_000 }]);
    const total = consommeParLaPaie + g50[0]!.montant + cnas[0]!.montant;
    expect(consommeParLaPaie).toBe(100_000);
    expect(total).toBe(entryCost(LIGNE));
  });
});

describe("l'avance sur salaire : trésorerie seulement", () => {
  it("un ordre d'avance ne touche aucun budget ; les autres ordres, si", () => {
    expect(ordreHorsBudget({ sourceType: "SALARY_ADVANCE" })).toBe(true);
    for (const s of ["PAYMENT_REQUEST", "TAX_PAYMENT", "FIXED_CHARGE", null]) expect(ordreHorsBudget({ sourceType: s })).toBe(false);
  });
});
