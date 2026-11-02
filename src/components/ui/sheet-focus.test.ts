import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sautDeFocus } from "./sheet-focus-regle";

/**
 * `Sheet` se déclare `aria-modal` : le focus doit y ENTRER, y RESTER, et REVENIR au bouton qui
 * l'avait ouverte (audit 27/10/2026, FRONTEND-UX-02). Avant, il restait derrière le voile et Tab
 * parcourait la page masquée.
 */
describe("Sheet — le focus d'une couche modale", () => {
  it("Tab au dernier élément revient au premier, Maj+Tab au premier va au dernier", () => {
    expect(sautDeFocus(4, 3, false)).toBe(0);
    expect(sautDeFocus(4, 0, true)).toBe(3);
  });
  it("au milieu de la liste, le navigateur fait seul", () => {
    expect(sautDeFocus(4, 1, false)).toBeNull();
    expect(sautDeFocus(4, 2, true)).toBeNull();
  });
  it("un focus hors de la couche est ramené à l'extrémité du sens", () => {
    expect(sautDeFocus(3, -1, false)).toBe(0);
    expect(sautDeFocus(3, -1, true)).toBe(2);
  });
  it("une couche sans rien de focusable ne fait rien", () => {
    expect(sautDeFocus(0, -1, false)).toBeNull();
  });

  const src = readFileSync("src/components/ui/sheet.tsx", "utf8").replace(/\/\/.*$/gm, "");
  it("la feuille pose le focus, piège Tab et rend le focus à la fermeture", () => {
    expect(src).toMatch(/ref=\{panneau\}/);
    expect(src).toMatch(/tabIndex=\{-1\}/);
    expect(src).toMatch(/sautDeFocus\(/);
    expect(src).toMatch(/avant\.focus\(/);
  });
});
