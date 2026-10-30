import { describe, expect, it } from "vitest";
import { aCompacter, apresLeResume, borner, RESUME_MAX_CARACTERES, SEUIL_ECHANGES, texteAResumer, VERBATIM_ECHANGES } from "./resume";

const echanges = (n: number) => Array.from({ length: n }, (_, i) => [
  { role: "user" as const, content: `question ${i}`, quand: new Date(Date.UTC(2026, 9, 1, 8, i)) },
  { role: "assistant" as const, content: `réponse ${i}`, quand: new Date(Date.UTC(2026, 9, 1, 8, i)) },
]).flat();

/** LE RÉSUMÉ ROULANT (J4) : quand, jusqu'où, et rien deux fois. */
describe("résumé roulant — règle pure (J4)", () => {
  it("ne résume rien tant que la fenêtre et le seuil tiennent", () => {
    expect(aCompacter(echanges(VERBATIM_ECHANGES + SEUIL_ECHANGES), null)).toBeNull();
  });

  it("résume tout sauf les derniers échanges, par paires entières", () => {
    const t = echanges(VERBATIM_ECHANGES + SEUIL_ECHANGES + 1);
    const p = aCompacter(t, null)!;
    expect(p.aResumer).toHaveLength((SEUIL_ECHANGES + 1) * 2);
    expect(p.aResumer[p.aResumer.length - 1].role).toBe("assistant");
    expect(apresLeResume(t, p.jusquA)).toHaveLength(VERBATIM_ECHANGES * 2);
  });

  it("IDEMPOTENT : sans échange nouveau, la compaction suivante ne fait rien", () => {
    const t = echanges(12);
    const p = aCompacter(t, null)!;
    expect(aCompacter(t, p.jusquA)).toBeNull();
    // Il faut de nouveau SEUIL + 1 échanges au-delà de la fenêtre pour résumer encore.
    const plus = [...t, ...echanges(12 + SEUIL_ECHANGES + 1).slice(24)];
    const p2 = aCompacter(plus, p.jusquA)!;
    expect(p2.aResumer.every((x) => x.quand.getTime() > p.jusquA.getTime())).toBe(true);
  });

  it("porte le résumé précédent, et reste borné", () => {
    expect(texteAResumer("- avant", echanges(1))).toContain("RÉSUMÉ PRÉCÉDENT :\n- avant");
    const long = Array.from({ length: 400 }, (_, i) => `- puce ${i}`).join("\n");
    expect(borner(long).length).toBeLessThanOrEqual(RESUME_MAX_CARACTERES + 2);
  });
});
