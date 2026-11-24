import { describe, expect, it } from "vitest";
import { couvertureParLettre } from "./couverture-lettres";

describe("la couverture du panel par lettre, en tête du plan", () => {
  const praticiens = [
    { id: "h1", lettre: "H", requis: 3 }, { id: "a1", lettre: "A", requis: 2 }, { id: "a2", lettre: "A", requis: 2 },
    { id: "c1", lettre: "C", requis: 1 }, { id: "x", lettre: null, requis: 1 }, { id: "nc", lettre: "NC", requis: 0 },
  ];
  it("prévu face au requis, dans l'ordre des lettres ; une lettre absente du panel ne s'affiche pas ; hors segmentation ne compte pas", () => {
    const r = couvertureParLettre(praticiens, ["2026-12-01|h1", "2026-12-02|a1", "2026-12-03|a1", "2026-12-03|a2", "2026-12-04|a2", "2026-12-04|x"]);
    expect(r.map((l) => [l.lettre, l.prevues, l.requises, l.manque, l.pct])).toEqual([
      ["H", 1, 3, 2, 33], ["A", 4, 4, 0, 100], ["C", 0, 1, 1, 0],
    ]);
  });
  it("au-delà du requis : plafonné à 100 %, rien ne manque", () => {
    expect(couvertureParLettre([{ id: "c1", lettre: "C", requis: 1 }], ["d|c1", "e|c1"])[0]).toMatchObject({ pct: 100, manque: 0, prevues: 2 });
  });
});
