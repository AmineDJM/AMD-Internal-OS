import { describe, expect, it } from "vitest";
import { apercuChamps, avertissementsUniques, etatSimulationAffiche, libelleOuverture } from "./carte-action";

describe("carte d'action compacte — règles pures", () => {
  it("un avertissement répété (casse, accents, ponctuation) ne se dit qu'une fois", () => {
    expect(avertissementsUniques(["Budget dépassé de 12 %.", "budget depasse de 12 %", "Pièce manquante"]))
      .toEqual(["Budget dépassé de 12 %.", "Pièce manquante"]);
  });

  it("une phrase contenue dans une plus complète cède la place, dans les deux sens", () => {
    expect(avertissementsUniques(["Doublon possible", "Doublon possible : SP-2026-014 du 12/10"])).toEqual(["Doublon possible : SP-2026-014 du 12/10"]);
    expect(avertissementsUniques(["Doublon possible : SP-2026-014 du 12/10", "Doublon possible"])).toEqual(["Doublon possible : SP-2026-014 du 12/10"]);
  });

  it("ce que la simulation dit déjà ne se répète pas en avertissement", () => {
    expect(avertissementsUniques(["Non simulable : action externe"], ["Non simulable : action externe. La carte montre ce qui est proposé."])).toEqual([]);
    expect(avertissementsUniques(["  ", ""])).toEqual([]);
  });

  it("une simulation échouée faute de champs obligatoires ne s'affiche pas comme un échec", () => {
    expect(etatSimulationAffiche("ECHEC", 2)).toBe("EN_ATTENTE_DES_CHAMPS");
    expect(etatSimulationAffiche("ECHEC", 0)).toBe("ECHEC");
    expect(etatSimulationAffiche("SIMULE", 1)).toBe("SIMULE");
    expect(etatSimulationAffiche(undefined, 0)).toBeNull();
  });

  it("le bouton dit ce qui reste à faire", () => {
    expect(libelleOuverture(1, true)).toBe("Compléter 1 champ");
    expect(libelleOuverture(3, false)).toBe("Compléter 3 champs");
    expect(libelleOuverture(0, true)).toBe("Vérifier et signer");
    expect(libelleOuverture(0, false)).toBe("Ouvrir et signer");
  });

  it("le résumé montre quatre champs au plus et compte le reste", () => {
    expect(apercuChamps([1, 2, 3, 4, 5, 6])).toEqual({ visibles: [1, 2, 3, 4], reste: 2 });
    expect(apercuChamps([1])).toEqual({ visibles: [1], reste: 0 });
  });
});
