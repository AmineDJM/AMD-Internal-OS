import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Finances › Comptabilité : le bandeau « N échéances en retard à traiter » est retiré (06/10) — et l'écran refait selon la
 * maquette validée (24/11/2026) ne le réintroduit pas. Les dépenses PRÉVUES, que le tableau de bord listait à part, sont
 * dans la liste des Dépenses, marquées « prévue ».
 */
const lire = (f: string) => readFileSync(join(process.cwd(), f), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // commentaires JSX
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const ecran = lire("src/app/(app)/finances/comptabilite/ecran-comptabilite.tsx");

describe("Comptabilité : plus de bandeau d'échéances en retard", () => {
  it("n'affiche plus « en retard à traiter » et ne lit plus enRetardCount", () => {
    expect(ecran).not.toContain("en retard à traiter");
    expect(ecran).not.toContain("enRetardCount");
  });

  it("une dépense prévue reste visible dans la liste, marquée « prévue »", () => {
    expect(ecran).toMatch(/l\.prevue && <span[^>]*>prévue<\/span>/);
  });
});
