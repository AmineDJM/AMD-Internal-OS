import { describe, it, expect } from "vitest";
import { placement, rectDuQuad, ajuster, matricePdf } from "./placement";

const A4 = { w: 595, h: 842 };
const recouvre = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placement des signatures sur le BC", () => {
  it("sous la mention « Signature et cachet », Direction Marketing à gauche, Finances à droite", () => {
    const ancre = rectDuQuad([380, 600, 470, 600, 380, 612, 470, 612]);
    const dm = placement(A4, ancre, "DIRECTION_MARKETING");
    const fi = placement(A4, ancre, "FINANCES");
    expect(dm.signature.y).toBeGreaterThan(ancre.y + ancre.h);
    expect(fi.signature.x).toBeGreaterThan(dm.signature.x);
    expect(recouvre(dm.cachet, fi.cachet)).toBe(false);
    expect(recouvre(dm.sceau, fi.sceau)).toBe(false);
  });
  it("tout reste dans la page, même ancrée près du bord ou trop bas", () => {
    for (const ancre of [rectDuQuad([560, 820, 590, 820, 560, 832, 590, 832]), null]) {
      for (const q of ["DIRECTION_MARKETING", "FINANCES"] as const) {
        const p = placement(A4, ancre, q);
        for (const r of [p.signature, p.cachet, p.sceau]) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(A4.w);
          expect(r.y + r.h).toBeLessThanOrEqual(A4.h);
        }
        expect(recouvre(p.signature, p.sceau)).toBe(false);
      }
    }
  });
  it("une image garde ses proportions, et la matrice PDF retourne l'axe vertical", () => {
    const r = ajuster({ x: 0, y: 0, w: 100, h: 50 }, 400, 400);
    expect(r).toEqual({ x: 25, y: 0, w: 50, h: 50 });
    expect(matricePdf({ x: 10, y: 20, w: 30, h: 40 }, 842)).toEqual([30, 0, 0, 40, 10, 782]);
  });
});
