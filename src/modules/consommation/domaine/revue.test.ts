import { describe, expect, it } from "vitest";
import { groupesARevoir, type LigneARevoir } from "./revue";

const ligne = (l: Partial<LigneARevoir>): LigneARevoir => ({
  etablissementBrut: null, produitBrut: null, molecule: null, institutionId: null, productId: null, anomalies: null, ...l,
});

describe("groupesARevoir — une décision par valeur brute", () => {
  it("regroupe les lignes d'un même établissement brut, casse et accents ignorés", () => {
    const g = groupesARevoir([
      ligne({ etablissementBrut: "CHU Oran", productId: "p1" }),
      ligne({ etablissementBrut: "chu  ORAN", productId: "p1" }),
    ]);
    expect(g).toEqual([{ nature: "ETABLISSEMENT", brut: "CHU Oran", lignes: 2, proposition: null }]);
  });

  it("garde la proposition de produit lue à l'import", () => {
    const proposition = { id: "p9", nom: "Produit 9", pourquoi: "même DCI" };
    const g = groupesARevoir([ligne({ institutionId: "i1", produitBrut: "R400", molecule: "x", anomalies: { propositionProduit: proposition } })]);
    expect(g).toEqual([{ nature: "PRODUIT", brut: "R400", lignes: 1, proposition }]);
  });

  it("une molécule seule sans proposition ne demande rien : elle compte hors référentiel", () => {
    expect(groupesARevoir([ligne({ institutionId: "i1", molecule: "paracetamol" })])).toEqual([]);
  });
});
