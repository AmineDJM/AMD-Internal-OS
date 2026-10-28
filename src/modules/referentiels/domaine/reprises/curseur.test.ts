import { describe, expect, it } from "vitest";
import { cumuler, curseurSuivant, lireCurseur, bilanVide } from "./curseur";

const S = ["A", "B", "C"] as const;

describe("curseur d'une reprise à plusieurs sources", () => {
  it("vide = début de la première source", () => {
    expect(lireCurseur(null, S)).toEqual({ source: "A", apresId: null });
    expect(lireCurseur("", S)).toEqual({ source: "A", apresId: null });
  });

  it("lit la source et l'identifiant ; « B: » = début de B", () => {
    expect(lireCurseur("B:ck123", S)).toEqual({ source: "B", apresId: "ck123" });
    expect(lireCurseur("B:", S)).toEqual({ source: "B", apresId: null });
  });

  it("refuse une source inconnue (un curseur d'une autre reprise)", () => {
    expect(() => lireCurseur("Z:1", S)).toThrow(/illisible/);
  });

  it("lot plein : même source après le dernier id ; lot court : source suivante ; dernière : fini", () => {
    expect(curseurSuivant(S, "A", [{ id: "1" }, { id: "2" }], 2)).toBe("A:2");
    expect(curseurSuivant(S, "A", [{ id: "1" }], 2)).toBe("B:");
    expect(curseurSuivant(S, "B", [], 2)).toBe("C:");
    expect(curseurSuivant(S, "C", [{ id: "9" }], 2)).toBeNull();
  });

  it("cumule deux bilans et borne les erreurs", () => {
    const a = { ...bilanVide(), lues: 2, liees: 1, erreurs: ["x"] };
    const b = { ...bilanVide(), lues: 3, ignorees: 3, erreurs: ["y", "z"] };
    expect(cumuler(a, b, 2)).toEqual({ lues: 5, creees: 0, liees: 1, doublonsProposes: 0, ignorees: 3, erreurs: ["x", "y"] });
  });
});
