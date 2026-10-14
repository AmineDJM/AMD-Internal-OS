import { describe, it, expect } from "vitest";
import { cumulerSousCategories } from "./cumul-categories";

describe("une catégorie comprend ses sous-catégories", () => {
  it("Masse salariale : le consommé de la sous-catégorie remonte dans la catégorie", () => {
    const cumul = cumulerSousCategories([
      { id: "ms", parentId: null, allocated: 20_000_000, consumed: 7_479_780.64, committed: 0 },
      { id: "infectio", parentId: "ms", allocated: 0, consumed: 11_210_171.5, committed: 50_000 },
      { id: "autre", parentId: null, allocated: 1_000, consumed: 10, committed: 0 },
    ]);
    const ms = cumul.get("ms")!;
    expect(ms.consumed).toBeCloseTo(18_689_952.14, 2);
    expect(ms.committed).toBe(50_000);
    expect(ms.remaining).toBeCloseTo(1_310_047.86, 2);
    expect(ms.pct).toBe(93);
    expect(ms.health).toBe("AT_RISK");
    // La sous-catégorie garde sa part ; l'autre catégorie n'est pas touchée.
    expect(cumul.get("infectio")!.consumed).toBe(11_210_171.5);
    expect(cumul.get("infectio")!.health).toBe("NONE");
    expect(cumul.get("autre")!.consumed).toBe(10);
  });

  it("cumule à toute profondeur et coupe une boucle corrompue sans double compte", () => {
    const cumul = cumulerSousCategories([
      { id: "a", parentId: null, allocated: 100, consumed: 1, committed: 0 },
      { id: "b", parentId: "a", allocated: 0, consumed: 2, committed: 0 },
      { id: "c", parentId: "b", allocated: 0, consumed: 4, committed: 0 },
      { id: "x", parentId: "y", allocated: 0, consumed: 8, committed: 0 },
      { id: "y", parentId: "x", allocated: 0, consumed: 16, committed: 0 },
    ]);
    expect(cumul.get("a")!.consumed).toBe(7);
    expect(cumul.get("b")!.consumed).toBe(6);
    expect(cumul.get("x")!.consumed).toBe(24);
  });
});
