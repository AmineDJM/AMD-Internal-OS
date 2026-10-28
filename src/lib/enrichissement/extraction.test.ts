import { describe, expect, it } from "vitest";
import { extraireParNature } from "./extraction";
import { NATURES_PIECE } from "./types";

describe("l'extraction par nature", () => {
  it("toute nature a une issue dite : un extracteur local, la lecture des pièces commerciales, ou « sans extracteur »", () => {
    for (const nature of NATURES_PIECE) {
      const e = extraireParNature(nature, { texte: "", nomFichier: null });
      if (e.genre === "FAITE") expect(e.resultat.local).toBe(true);
      if (e.genre === "SANS_EXTRACTEUR") expect(e.note).toContain(nature);
    }
  });
  it("un devis part vers la lecture des pièces ; un bulletin de paie n'a pas d'extracteur", () => {
    expect(extraireParNature("DEVIS", { texte: "x", nomFichier: null }).genre).toBe("COMMERCIALE");
    expect(extraireParNature("BULLETIN_PAIE", { texte: "x", nomFichier: null }).genre).toBe("SANS_EXTRACTEUR");
    expect(extraireParNature("PASSEPORT", { texte: "x", nomFichier: null }).genre).toBe("FAITE");
  });
});
