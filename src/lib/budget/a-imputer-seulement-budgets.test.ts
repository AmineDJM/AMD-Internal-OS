import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * « À IMPUTER » NE VIT QUE DANS BUDGETS (Direction, 19/10/2026 : « ça doit être que dans le module Budgets, par Budget
 * Marketing etc. »). La liste — « Tout sélectionner », le total, « Pièces », « Imputer à… » — est celle de
 * `BudgetExpenses`, montée par l'onglet Dépenses de `vues-budget.tsx`. Les budgets de pôle n'en montrent que le compte
 * et un lien vers l'enveloppe dans Budgets (`renvoiAImputer`) ; ce banc lit le source pour qu'une nouvelle page ne la
 * remonte pas ailleurs sans le dire.
 */

const RACINE = join(process.cwd(), "src");
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
const VUES = join(RACINE, "app", "(app)", "budgets", "vues-budget.tsx");

describe("« À imputer » seulement dans Budgets", () => {
  it("la liste n'est montée que par les vues de budget", () => {
    const monteurs = sources(RACINE)
      .filter((f) => /<BudgetExpenses\b/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(RACINE.length + 1).split("\\").join("/"));
    expect(monteurs).toEqual(["app/(app)/budgets/vues-budget.tsx"]);
  });

  it("chaque montage passe `renvoiAImputer`, posé seulement hors de Budgets", () => {
    const src = readFileSync(VUES, "utf8");
    const montages = src.split("<BudgetExpenses").slice(1).map((m) => m.slice(0, m.indexOf("/>")));
    expect(montages.length).toBeGreaterThan(0);
    for (const m of montages) expect(m).toMatch(/renvoiAImputer=\{renvoiAImputer\}/);
    expect(src).toMatch(/const renvoiAImputer = config\.portee !== "TOUT"/);
  });

  it("hors de Budgets, les alertes mènent à Budgets › Dépenses, jamais à l'onglet Dépenses du pôle", () => {
    const src = readFileSync(VUES, "utf8");
    expect(src).toMatch(/return `\/budgets\/depenses\?env=\$\{envelopeId\}`/);
    expect(src).toMatch(/const lienAImputer = pole \? await lienAImputerBudgets\(/);
    const regulatory = readFileSync(join(RACINE, "app", "(app)", "budgets", "vue-regulatory.tsx"), "utf8");
    expect(regulatory).not.toMatch(/\/depenses\?env=/);
  });
});
