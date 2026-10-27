import { describe, expect, it } from "vitest";

/**
 * Garde de configuration : l'optimiseur d'images de Next 14 (`/_next/image`) est un point
 * d'entrée PUBLIC dont les failles publiées ne sont plus corrigées sur la branche 14 (audit
 * 27/10, INFRA-04). Il reste fermé tant que Next n'est pas monté de version.
 */
describe("next.config.mjs — surface publique", () => {
  it("l'optimiseur d'images est désactivé (le point d'entrée répond 404)", async () => {
    const mod = (await import("../../../next.config.mjs")) as { default: (phase: string) => { images?: { unoptimized?: boolean } } };
    const config = mod.default("phase-production-server");
    expect(config.images?.unoptimized).toBe(true);
  });
});
