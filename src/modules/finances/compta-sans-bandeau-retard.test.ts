import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Finances › Comptabilité : le bandeau « N échéances en retard à traiter » est retiré (06/10). */
const code = readFileSync(join(process.cwd(), "src/app/(app)/finances/compta-cockpit.tsx"), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // commentaires JSX
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("Comptabilité : plus de bandeau d'échéances en retard", () => {
  it("n'affiche plus « en retard à traiter » et ne lit plus enRetardCount", () => {
    expect(code).not.toContain("en retard à traiter");
    expect(code).not.toContain("enRetardCount");
  });

  it("garde le reste du tableau de bord (autres dépenses prévues)", () => {
    expect(code).toContain("Autres dépenses prévues");
  });
});
