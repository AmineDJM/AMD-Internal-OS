import { describe, expect, it } from "vitest";
import { extraire, extraitAPlat, plierAligne, termesDe } from "./extrait";

describe("L'extrait surligné", () => {
  it("surligne les mots de la requête, accents et pluriels compris", () => {
    const s = extraire("Le Règlement intérieur précise les règlements des congés.", "reglements interieur");
    expect(extraitAPlat(s)).toBe("Le **Règlement** **intérieur** précise les **règlements** des congés.");
  });
  it("centre la fenêtre sur la première occurrence d'un long texte", () => {
    const texte = `${"remplissage ".repeat(100)}La pharmacovigilance du lot 42 est close. ${"suite ".repeat(100)}`;
    const plat = extraitAPlat(extraire(texte, "pharmacovigilance"));
    expect(plat.startsWith("… ")).toBe(true);
    expect(plat.endsWith(" …")).toBe(true);
    expect(plat).toContain("**pharmacovigilance**");
    expect(plat.length).toBeLessThan(300);
  });
  it("sans terme reconnu, rend le début du texte, sans rien surligner", () => {
    const s = extraire("Bonjour à tous.", "de la");
    expect(s.every((x) => !x.fort)).toBe(true);
  });
  it("le repli garde la longueur (les positions restent celles du texte affiché)", () => {
    const t = "Œuvre déjà réglée — ÉTÉ";
    expect(plierAligne(t).length).toBe(t.length);
    expect(termesDe("Le contrat DE travail d'Amina")).toEqual(["contrat", "travail", "amina"]);
  });
});
