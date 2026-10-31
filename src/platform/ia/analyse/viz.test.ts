import { describe, expect, it } from "vitest";
import { recommanderGraphique, verifierGraphique } from "./viz";

/**
 * LA VISUALISATION EXPERTE — le bon graphique pour la forme des données et l'intention de la
 * question, et surtout ce qui TROMPE : l'axe tronqué, le camembert à quinze parts, le double
 * axe, la 3D, le log non dit, le cumul déguisé, la courbe qui relie ce qui ne se suit pas.
 */
const parMois = ["2026-01", "2026-02", "2026-03", "2026-04"].map((periode, i) => ({ periode, valeur: 100 + i * 20 }));
const parSociete = [{ societe: "Adventum", total: 900 }, { societe: "Pharmalliance", total: 300 }, { societe: "ASARI", total: 150 }];
const quinze = Array.from({ length: 15 }, (_, i) => ({ categorie: `C${i}`, valeur: 10 + i }));

describe("recommander", () => {
  it("une série dans le temps se lit en courbe, sans imposer l'axe à zéro", () => {
    const s = recommanderGraphique(parMois, "évolution des ventes par mois");
    expect(s.type).toBe("courbe");
    expect(s.x).toBe("periode");
    expect(s.axeYdepartZero).toBe(false);
  });
  it("une comparaison de catégories se lit en barres, axe à zéro", () => {
    const s = recommanderGraphique(parSociete, "compare les sociétés");
    expect(s.type).toBe("barres");
    expect(s.axeYdepartZero).toBe(true);
  });
  it("une répartition à trois parts va en secteurs ; à quinze parts, en barres — jamais un camembert illisible", () => {
    expect(recommanderGraphique(parSociete, "répartition du chiffre par société").type).toBe("secteurs");
    expect(recommanderGraphique(quinze, "répartition par catégorie").type).toBe("barres");
  });
  it("deux mesures sans catégorie : nuage ; aucune mesure : tableau", () => {
    expect(recommanderGraphique([{ a: 1, b: 2 }, { a: 2, b: 4 }, { a: 3, b: 9 }], "corrélation entre a et b").type).toBe("nuage");
    expect(recommanderGraphique([{ nom: "x" }, { nom: "y" }], "").type).toBe("tableau");
    expect(recommanderGraphique([], "").type).toBe("tableau");
  });
  it("chaque recommandation dit pourquoi", () => {
    expect(recommanderGraphique(parMois, "tendance").raison.length).toBeGreaterThan(10);
  });
});

describe("vérifier — ce qui trompe", () => {
  it("des barres dont l'axe ne part pas de zéro : TROMPEUR", () => {
    const a = verifierGraphique({ type: "barres", titre: "t", x: "societe", y: ["total"], axeYdepartZero: false, raison: "" }, parSociete);
    expect(a.map((x) => x.code)).toContain("axe_tronque");
    expect(a.find((x) => x.code === "axe_tronque")!.gravite).toBe("TROMPEUR");
  });
  it("un camembert à quinze parts, ou avec une part négative, ou qui n'est pas un tout", () => {
    expect(verifierGraphique({ type: "secteurs", titre: "t", x: "categorie", y: ["valeur"], axeYdepartZero: true, raison: "" }, quinze).map((x) => x.code)).toContain("secteurs_trop_de_parts");
    expect(verifierGraphique({ type: "secteurs", titre: "t", x: "k", y: ["v"], axeYdepartZero: true, raison: "" }, [{ k: "a", v: 5 }, { k: "b", v: -2 }]).map((x) => x.code)).toContain("secteurs_negatif");
    expect(verifierGraphique({ type: "secteurs", titre: "t", x: "k", y: ["v"], axeYdepartZero: true, raison: "" }, [{ k: "total", v: 100 }, { k: "part", v: 0.01 }]).map((x) => x.code)).toContain("secteurs_pas_un_tout");
  });
  it("double axe, 3D, log non dit, cumul non dit", () => {
    const codes = verifierGraphique({ type: "courbe", titre: "Ventes", x: "periode", y: ["valeur"], axeYdepartZero: false, doubleAxe: true, troisD: true, echelle: "log", cumul: true, raison: "" }, parMois).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["double_axe", "trois_d", "log_non_dit", "cumul_non_dit"]));
    const dits = verifierGraphique({ type: "courbe", titre: "Ventes cumulées (échelle log)", x: "periode", y: ["valeur"], axeYdepartZero: false, echelle: "log", cumul: true, raison: "" }, parMois).map((x) => x.code);
    expect(dits).not.toContain("log_non_dit");
    expect(dits).not.toContain("cumul_non_dit");
  });
  it("une courbe sur des catégories, ou à deux points, est signalée ; une vraie série ne l'est pas", () => {
    expect(verifierGraphique({ type: "courbe", titre: "t", x: "societe", y: ["total"], axeYdepartZero: false, raison: "" }, parSociete).map((x) => x.code)).toContain("courbe_sans_temps");
    expect(verifierGraphique({ type: "courbe", titre: "t", x: "periode", y: ["valeur"], axeYdepartZero: false, raison: "" }, parMois.slice(0, 2)).map((x) => x.code)).toContain("courbe_trop_courte");
    expect(verifierGraphique(recommanderGraphique(parMois, "évolution"), parMois)).toEqual([]);
  });
});
