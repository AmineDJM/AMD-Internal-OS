import { describe, expect, it } from "vitest";

/**
 * Garde de configuration : l'optimiseur d'images de Next (`/_next/image`) est un point d'entrée
 * PUBLIC. Fermé sous Next 14, dont les failles publiées n'étaient plus corrigées (audit 27/10,
 * INFRA-04) ; Next 15.5.28 les corrige (INFRA-03), mais l'application ne s'en sert que pour une
 * image décorative : la surface reste fermée tant qu'un écran n'en a pas réellement besoin.
 */
describe("next.config.mjs — surface publique", () => {
  it("l'optimiseur d'images est désactivé (le point d'entrée répond 404)", async () => {
    const mod = (await import("../../../next.config.mjs")) as { default: (phase: string) => { images?: { unoptimized?: boolean } } };
    const config = mod.default("phase-production-server");
    expect(config.images?.unoptimized).toBe(true);
  });
});
