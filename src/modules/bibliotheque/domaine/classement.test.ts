import { describe, expect, it } from "vitest";
import { fusionner, K_RRF } from "./classement";

describe("La fusion des classements (RRF)", () => {
  it("une pièce trouvée par deux voies passe devant une pièce trouvée par une seule, même mieux placée", () => {
    const r = fusionner({
      "plein-texte": [{ pieceId: "A", passageId: "a1" }, { pieceId: "B", passageId: "b1" }],
      vecteur: [{ pieceId: "C", passageId: "c1" }, { pieceId: "B", passageId: "b2" }],
    });
    expect(r[0].pieceId).toBe("B");
    expect(r[0].rangs).toEqual({ "plein-texte": 2, vecteur: 2 });
    expect(r[0].score).toBeCloseTo(2 / (K_RRF + 2));
  });
  it("une pièce compte une fois par voie, par son meilleur passage, et cite ce passage", () => {
    const r = fusionner({ "plein-texte": [{ pieceId: "A", passageId: "a1" }, { pieceId: "A", passageId: "a2" }] });
    expect(r).toHaveLength(1);
    expect(r[0].score).toBeCloseTo(1 / (K_RRF + 1));
    expect(r[0].passageId).toBe("a1");
  });
  it("le titre classe la pièce entière (sans passage) ; l'ordre est stable", () => {
    const r = fusionner({ titre: [{ pieceId: "Z", passageId: null }, { pieceId: "Y", passageId: null }] });
    expect(r.map((x) => x.pieceId)).toEqual(["Z", "Y"]);
    expect(r[0].passageId).toBeNull();
  });
});
