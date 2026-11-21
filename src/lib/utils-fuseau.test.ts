import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime } from "./utils";

/**
 * L'HEURE D'ALGER, QUEL QUE SOIT LE FUSEAU DU SERVEUR (recette, 21/11/2026) : la « Traçabilité » d'une demande créée à
 * 18:09 (Alger) disait 17:09 — l'heure UTC du serveur Render.
 */
describe("formatDate / formatDateTime — à l'heure d'Alger", () => {
  it("une heure UTC s'affiche à l'heure d'Alger (UTC+1)", () => {
    expect(formatDateTime(new Date("2026-11-21T17:09:43Z"))).toContain("18:09");
  });

  it("une date seule stockée à minuit UTC reste le même jour", () => {
    expect(formatDate(new Date("2026-12-12T00:00:00Z"))).toMatch(/^12 déc\.? 2026$/);
  });

  it("un appelant qui donne son propre fuseau le garde", () => {
    expect(formatDate(new Date("2026-11-21T23:30:00Z"), { day: "2-digit", timeZone: "UTC" })).toBe("21");
    expect(formatDate(new Date("2026-11-21T23:30:00Z"), { day: "2-digit" })).toBe("22");
  });
});
