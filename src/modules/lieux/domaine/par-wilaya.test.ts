import { describe, expect, it } from "vitest";
import { regrouperParWilaya } from "./par-wilaya";

describe("regrouperParWilaya", () => {
  const comptes = [{ code: "16", n: 4 }, { code: "31", n: 4 }, { code: "68", n: 2 }, { code: "28", n: 1 }, { code: null, n: 3 }];

  it("un rang par wilaya officielle, par effectif puis par code, et la part sans code à côté", () => {
    expect(regrouperParWilaya(comptes)).toEqual({
      rangs: [{ code: "16", nom: "Alger", n: 4 }, { code: "31", nom: "Oran", n: 4 }, { code: "68", nom: "Bou Saâda", n: 2 }, { code: "28", nom: "M'Sila", n: 1 }],
      sansCode: 3,
      total: 14,
    });
  });

  it("découpage à 58 : une nouvelle wilaya rejoint sa mère", () => {
    const r = regrouperParWilaya(comptes, { decoupage: "58" });
    expect(r.rangs.find((x) => x.code === "28")?.n).toBe(3);
    expect(r.rangs.some((x) => x.code === "68")).toBe(false);
    expect(r.total).toBe(14);
  });

  it("un code inconnu n'invente pas une wilaya : il compte sans code", () => {
    expect(regrouperParWilaya([{ code: "99", n: 2 }])).toEqual({ rangs: [], sansCode: 2, total: 2 });
  });
});
