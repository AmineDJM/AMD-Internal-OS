import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Demande de paiement d'un salarié : rattachée d'office à Adventum, sans choix d'entité (06/10).
 * Garde de SOURCE (le flux complet, sur base, est dans actions/money-entity-flow.test.ts).
 */
const lire = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("demande de paiement : Adventum d'office", () => {
  it("le formulaire ne propose plus de choix d'entité", () => {
    const form = lire("src/app/(app)/validations/paiements/new-payment-button.tsx");
    expect(form).not.toContain("pay-company");
    expect(form).not.toContain('name="companyId"');
    expect(form).not.toContain("defaultCompanyId");
  });

  it("les deux pages n'envoient plus d'entités au formulaire", () => {
    for (const f of ["src/app/(app)/validations/page.tsx", "src/app/(app)/validations/paiements/page.tsx"]) {
      expect(lire(f), f).not.toMatch(/<NewPaymentButton[^/]*companies=/);
    }
  });

  it("le serveur rattache à Adventum avant toute autre règle", () => {
    const src = lire("src/modules/finances/actions-demandes.ts");
    expect(src).toMatch(/const adventumId = await adventumCompanyId\(\);\s*const companyId = adventumId \?\?/);
  });
});
