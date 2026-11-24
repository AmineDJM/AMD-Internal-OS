import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * UNE SEULE ENTRÉE POUR LE CENTRE DE VALIDATIONS (Super Admin, 24/11/2026) — qui siège au centre ne voit plus
 * « Demandes de validations » en double : les deux entrées mènent au même écran (`/validations`).
 */
describe("menu — une seule entrée vers /validations", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/nav-access.ts"), "utf8");
  it("l'entrée « Demandes de validations » est retirée pour qui siège au centre", () => {
    expect(src).toMatch(/const siegeAuCentre = NAVIGATION\.some\(\(n\) => n\.module === "VALIDATION_CENTRE"/);
    expect(src).toMatch(/if \(siegeAuCentre && n\.module === "VALIDATIONS" && n\.href === "\/validations"\) return acc;/);
  });
});
