import { describe, expect, it } from "vitest";
import { ordreDeRevue } from "./revue";

describe("ordre de revue des doublons", () => {
  it("le niveau d'abord, puis le score", () => {
    const tries = ordreDeRevue([
      { id: "a", niveau: "POSSIBLE", score: 99 },
      { id: "b", niveau: "CERTAIN", score: 40 },
      { id: "c", niveau: "PROBABLE", score: 70 },
      { id: "d", niveau: "CERTAIN", score: 80 },
    ]);
    expect(tries.map((p) => p.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("un niveau inconnu passe en dernier, et l'entrée n'est pas modifiée", () => {
    const entree = [{ id: "x", niveau: "AUTRE", score: 100 }, { id: "y", niveau: "POSSIBLE", score: 1 }];
    expect(ordreDeRevue(entree).map((p) => p.id)).toEqual(["y", "x"]);
    expect(entree.map((p) => p.id)).toEqual(["x", "y"]);
  });
});
