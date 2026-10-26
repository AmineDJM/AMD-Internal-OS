import { describe, it, expect } from "vitest";
import {
  NATURES_PAR_DEFAUT, categorieDuMemeNom, cleDeComparaison, devinerParMotsCles, lireClassement, lireValeurNouvelle,
  normaliserNomNature, valeurNouvelle, type CategorieConnue,
} from "./natures";

const CATS: CategorieConnue[] = NATURES_PAR_DEFAUT.map((n, i) => ({ id: `c${i}`, nom: n.nom, cle: n.cle }));
const idDe = (cle: string) => CATS.find((c) => c.cle === cle)!.id;

describe("natures des moyens généraux — les catégories par défaut", () => {
  it("quatorze catégories, clés uniques, « Autre » en dernier recours", () => {
    expect(NATURES_PAR_DEFAUT).toHaveLength(14);
    expect(new Set(NATURES_PAR_DEFAUT.map((n) => n.cle)).size).toBe(14);
    expect(NATURES_PAR_DEFAUT.at(-1)?.cle).toBe("MG_AUTRE");
  });
});

describe("le nom d'une nouvelle catégorie", () => {
  it("se nettoie : espaces, guillemets, ponctuation finale, capitale", () => {
    expect(normaliserNomNature("  « abonnements   logiciels ». ")).toBe("Abonnements logiciels");
    expect(normaliserNomNature("Ab")).toBeNull();
    expect(normaliserNomNature("x".repeat(100))?.length).toBe(60);
  });

  it("voyage dans le champ de la ligne, préfixé", () => {
    expect(lireValeurNouvelle(valeurNouvelle("frais de formation"))).toBe("Frais de formation");
    expect(lireValeurNouvelle("cuid123")).toBeNull();
    expect(lireValeurNouvelle(null)).toBeNull();
  });

  it("ne double jamais une catégorie : accents, casse, « & », pluriel près", () => {
    expect(cleDeComparaison("Cuisine, café & réception")).toBe(cleDeComparaison("cuisine cafe et receptions"));
    expect(categorieDuMemeNom("telecom et internet", CATS)?.cle).toBe("MG_TELECOM");
    expect(categorieDuMemeNom("Abonnements logiciels", CATS)).toBeNull();
  });
});

describe("le repli sans IA : les mots-clés", () => {
  it("range les libellés courants de l'assistante", () => {
    expect(devinerParMotsCles("Recharge Djezzy 1000", CATS)).toBe(idDe("MG_TELECOM"));
    expect(devinerParMotsCles("Café et sucre pour la réunion", CATS)).toBe(idDe("MG_CUISINE"));
    expect(devinerParMotsCles("2 cartouches HP 305", CATS)).toBe(idDe("MG_IMPRESSION"));
    expect(devinerParMotsCles("Ramettes A4", CATS)).toBe(idDe("MG_FOURNITURES"));
    expect(devinerParMotsCles("Taxi aéroport", CATS)).toBe(idDe("MG_TRANSPORT"));
    expect(devinerParMotsCles("Envoi Yalidine Oran", CATS)).toBe(idDe("MG_COURRIER"));
    expect(devinerParMotsCles("Timbres fiscaux", CATS)).toBe(idDe("MG_ADMINISTRATIF"));
  });

  it("le mot-clé le plus long gagne : le papier toilette n'est pas de la papeterie", () => {
    expect(devinerParMotsCles("Papier toilette x12", CATS)).toBe(idDe("MG_ENTRETIEN"));
    expect(devinerParMotsCles("Fournitures de bureau", CATS)).toBe(idDe("MG_FOURNITURES"));
  });

  it("rien qui parle → null ; une catégorie par défaut absente n'est pas proposée", () => {
    expect(devinerParMotsCles("Divers", CATS)).toBeNull();
    expect(devinerParMotsCles("Recharge Djezzy", CATS.filter((c) => c.cle !== "MG_TELECOM"))).toBeNull();
  });
});

describe("la réponse du modèle est relue", () => {
  it("garde les identifiants connus, crée les noms nouveaux, ramène un doublon à l'existant", () => {
    const r = lireClassement({
      lignes: [
        { index: 0, categorieId: idDe("MG_CUISINE"), nouvelle: null },
        { index: 1, categorieId: null, nouvelle: "abonnements logiciels" },
        { index: 2, categorieId: null, nouvelle: "Télécom & Internet" },
      ],
    }, 3, CATS);
    expect(r).toEqual([
      { categorieId: idDe("MG_CUISINE") },
      { nouvelle: "Abonnements logiciels" },
      { categorieId: idDe("MG_TELECOM") },
    ]);
  });

  it("écarte un identifiant inventé, un index hors bornes ou répété, une réponse informe", () => {
    const r = lireClassement({
      lignes: [
        { index: 0, categorieId: "inventee", nouvelle: null },
        { index: 0, categorieId: idDe("MG_AUTRE"), nouvelle: null },
        { index: 5, categorieId: idDe("MG_AUTRE"), nouvelle: null },
        { index: 1, categorieId: null, nouvelle: "x" },
      ],
    }, 2, CATS);
    expect(r).toEqual([null, null]);
    expect(lireClassement("n'importe quoi", 2, CATS)).toEqual([null, null]);
  });
});
