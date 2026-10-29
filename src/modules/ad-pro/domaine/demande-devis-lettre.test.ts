import { describe, it, expect } from "vitest";
import { lettreDeSecours, lettreValide, puceDeSecours, texteDeLaLettre, enumerer, type ArticleADeviser } from "./demande-devis-lettre";

const lingettes: ArticleADeviser = {
  designation: "Cadeaux fin d'année", quantite: 500, unite: "pièce",
  prestations: ["Conception", "Impression", "Fabrication", "Achat"],
  precision: "\"Lingettes désinfectantes brandées Adventum en boites\"", produits: [],
};
const brochure: ArticleADeviser = { designation: "Brochure Cardiomax", quantite: 1500, unite: "exemplaire", prestations: ["Impression"], precision: null, produits: ["Cardiomax"] };

describe("la demande de devis en lettre (Direction, 07/10)", () => {
  it("une puce dit QUOI faire, de COMBIEN, et la précision — dans les mots d'une lettre", () => {
    expect(puceDeSecours(lingettes)).toBe(
      "la conception, l'impression, la fabrication et la fourniture de 500 pièces « Cadeaux fin d'année » — Lingettes désinfectantes brandées Adventum en boites",
    );
    expect(puceDeSecours(brochure)).toBe("l'impression de 1 500 exemplaires « Brochure Cardiomax » (produits promus : Cardiomax)");
    expect(enumerer(["a"])).toBe("a");
    expect(enumerer(["a", "b", "c"])).toBe("a, b et c");
  });

  it("la lettre de secours est complète : objet, puces, précisions (BAT quand on imprime), politesse", () => {
    const l = lettreDeSecours({ titre: "TEST1", articles: [lingettes] });
    expect(l.objet).toBe("Demande de devis — TEST1");
    expect(l.puces).toHaveLength(1);
    expect(l.precisions.join(" ")).toMatch(/bon à tirer/);
    const t = texteDeLaLettre(l);
    expect(t).toMatch(/^Objet : Demande de devis — TEST1/);
    expect(t).toMatch(/Madame, Monsieur,/);
    expect(t).toMatch(/• la conception/);
  });

  it("ce qu'on accepte de Luna : une puce par article, chaque quantité recopiée telle quelle", () => {
    const bon = {
      objet: "Demande de devis — cadeaux de fin d'année", introduction: "Nous souhaiterions recevoir votre offre pour :",
      puces: ["La conception et la fourniture de 500 boîtes de lingettes brandées Adventum", "L'impression de 1 500 brochures Cardiomax"],
      precisions: ["le prix unitaire HT"], conclusion: "Dans l'attente de votre retour.",
    };
    expect(lettreValide(bon, [lingettes, brochure])?.puces).toHaveLength(2);
    // Une quantité changée, un article oublié, un champ manquant : refusé — la lettre de secours partira.
    expect(lettreValide({ ...bon, puces: ["5 000 boîtes", bon.puces[1]] }, [lingettes, brochure])).toBeNull();
    expect(lettreValide({ ...bon, puces: [bon.puces[0]] }, [lingettes, brochure])).toBeNull();
    expect(lettreValide({ ...bon, objet: "" }, [lingettes, brochure])).toBeNull();
    // Sans précision rendue : les précisions standard.
    expect(lettreValide({ ...bon, precisions: [] }, [lingettes, brochure])?.precisions.length).toBeGreaterThan(0);
  });
});
