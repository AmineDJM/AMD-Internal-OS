import { describe, expect, it } from "vitest";
import {
  accuseDeReponse, construireAgenda, estimerDureeMs, estNouvelleDemande, lireReponseAgenda, phraseAvancement, precisionDeLaReponse, voieDuMessage,
} from "./agenda";

/** L'AGENDA (lot O1, décision 0046) — dérivé de la demande, jamais une question dont la réponse ne servira pas. */
describe("agenda de conversation — règles pures", () => {
  it("un rapport de ventes sans format ni période : format, période, puis l'envoi", () => {
    expect(construireAgenda("Prépare-moi un rapport des ventes par wilaya").map((g) => g.cle)).toEqual(["format", "periode", "destinataire"]);
  });

  it("ce que la demande dit déjà n'est jamais redemandé", () => {
    expect(construireAgenda("Exporte en PDF les ventes d'octobre 2026 et envoie-le à Amel par mail")).toEqual([]);
    expect(construireAgenda("Fais un rapport détaillé en Excel des stocks ce mois-ci").map((g) => g.cle)).toEqual(["destinataire"]);
  });

  it("une question courte sans livrable n'a pas d'agenda — on ne meuble pas", () => {
    expect(construireAgenda("Combien de clients à Oran ?")).toEqual([]);
    expect(construireAgenda("Explique-moi ce qu'est une AMM")).toEqual([]);
  });

  it("une recherche ou une analyse : le niveau de détail", () => {
    expect(construireAgenda("Fais une recherche sur les concurrents de l'amoxicilline").map((g) => g.cle)).toEqual(["detail"]);
  });

  it("lire la réponse : choix reconnu, format dit autrement, « peu importe » sans effet", () => {
    const f = { cle: "format", choix: ["Excel", "PDF", "Peu importe"] };
    expect(lireReponseAgenda(f, "en PDF s'il te plaît")).toEqual({ valeur: "PDF", sansEffet: false });
    expect(lireReponseAgenda(f, "un xlsx")).toEqual({ valeur: "Excel", sansEffet: false });
    expect(lireReponseAgenda(f, "Peu importe.")).toMatchObject({ sansEffet: true });
    // Une politesse n'est pas une valeur : rien n'est transmis au travail.
    expect(lireReponseAgenda(f, "merci")).toMatchObject({ sansEffet: true });
    expect(lireReponseAgenda({ cle: "destinataire", choix: ["C'est pour moi"] }, "c'est pour moi")).toEqual({ valeur: "C'est pour moi", sansEffet: true });
    expect(lireReponseAgenda({ cle: "destinataire", choix: ["C'est pour moi"] }, "À Amel")).toEqual({ valeur: "À Amel", sansEffet: false });
    expect(lireReponseAgenda({ cle: "periode", choix: ["Ce mois-ci", "Le trimestre", "L'année"] }, "le trimestre")).toEqual({ valeur: "Le trimestre", sansEffet: false });
  });

  it("précision transmise et accusé : la valeur redite, jamais « j'attends »", () => {
    expect(precisionDeLaReponse("format", "PDF")).toBe("Format de rendu voulu : PDF.");
    expect(precisionDeLaReponse("destinataire", "Amel")).toContain("rien ne part sans confirmation");
    expect(accuseDeReponse("PDF", true)).toContain("Noté, PDF");
    expect(accuseDeReponse("PDF", false)).not.toMatch(/attend/);
  });

  it("autre demande ou précision ? déterministe", () => {
    expect(estNouvelleDemande("Combien de commandes en attente chez Saidal ?")).toBe(true);
    expect(estNouvelleDemande("Donne-moi le stock d'amoxicilline à Alger")).toBe(true);
    expect(estNouvelleDemande("plutôt sur 2025")).toBe(false);
    expect(estNouvelleDemande("et aussi Oran")).toBe(false);
    expect(estNouvelleDemande("en PDF")).toBe(false);
    expect(estNouvelleDemande("Le trimestre")).toBe(false);
  });

  it("la voie d'un message écrit : réponse, parallèle (travail long), ou la file", () => {
    expect(voieDuMessage({ texte: "PDF", questionEnAttente: true, travailEnCoursDepuisMs: 20_000 })).toBe("reponse");
    expect(voieDuMessage({ texte: "Combien de clients à Oran ?", questionEnAttente: true, travailEnCoursDepuisMs: 20_000 })).toBe("parallele");
    expect(voieDuMessage({ texte: "Combien de clients à Oran ?", questionEnAttente: false, travailEnCoursDepuisMs: 2_000 })).toBe("suite");
    expect(voieDuMessage({ texte: "plutôt sur 2025", questionEnAttente: false, travailEnCoursDepuisMs: 30_000 })).toBe("suite");
  });

  it("l'avancement : étapes réelles, sous-missions, durée estimée d'après l'historique", () => {
    expect(estimerDureeMs([1000, 2000])).toBeNull();
    expect(estimerDureeMs([60_000, 80_000, 90_000, 70_000])).toBe(75_000);
    expect(phraseAvancement({ etapes: ["Annuaire consulté", "Ventes lues"], ecouleMs: 20_000, estimeMs: 75_000, sousMissions: null }))
      .toBe("2 étapes faites (dernière : ventes lues), d'habitude, encore environ 1 minute.");
    expect(phraseAvancement({ etapes: [], ecouleMs: 1_000, estimeMs: null, sousMissions: { finies: 1, total: 3 } })).toBe("Le travail a commencé, 1 sous-mission finie sur 3.");
  });
});
