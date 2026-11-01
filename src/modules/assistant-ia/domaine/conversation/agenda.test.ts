import { describe, expect, it } from "vitest";
import { accuseDeReponse, construireAgenda, estimerDureeMs, lireReponseAgenda, phraseAvancement, precisionDeLaReponse } from "./agenda";
import { classerParRepli, classerSansModele, lireClassement, voieDuClassement } from "./classement";

/** L'AGENDA ET LE CLASSEMENT (lot O1, décision 0046) — dérivés de la demande, jamais une question dont la réponse ne sert pas. */
describe("agenda de conversation — règles pures", () => {
  it("un rapport de ventes : format, période, ventilation, comparaison, vigilance, puis l'envoi — sans plafond fixe", () => {
    const a = construireAgenda("Prépare-moi un rapport des ventes");
    expect(a.map((g) => g.cle)).toEqual(["format", "periode", "detail", "ventilation", "comparaison", "vigilance", "destinataire"]);
    // L'impact de chaque élément : la forme (mineur) ne relance rien ; le fond (majeur) est réinjecté.
    expect(Object.fromEntries(a.map((g) => [g.cle, g.impact]))).toMatchObject({ format: "mineur", detail: "mineur", destinataire: "mineur", periode: "majeur", comparaison: "majeur", ventilation: "majeur" });
  });

  it("ce que la demande dit déjà n'est jamais redemandé", () => {
    expect(construireAgenda("Exporte en PDF les ventes d'octobre 2026 par wilaya, comparées à l'an dernier, et envoie-le à Amel par mail")).toEqual([]);
    expect(construireAgenda("Fais un rapport détaillé en Excel des stocks ce mois-ci par produit avec les risques").map((g) => g.cle)).toEqual(["comparaison", "destinataire"]);
  });

  it("une question courte sans livrable n'a pas d'agenda — on ne meuble pas", () => {
    expect(construireAgenda("Combien de clients à Oran ?")).toEqual([]);
    expect(construireAgenda("Explique-moi ce qu'est une AMM")).toEqual([]);
  });

  it("lire la réponse : choix reconnu, format dit autrement, oui / non, « peu importe » sans effet", () => {
    const f = { cle: "format", choix: ["Excel", "PDF", "Peu importe"] };
    expect(lireReponseAgenda(f, "en PDF s'il te plaît")).toEqual({ valeur: "PDF", sansEffet: false });
    expect(lireReponseAgenda(f, "un xlsx")).toEqual({ valeur: "Excel", sansEffet: false });
    expect(lireReponseAgenda(f, "Peu importe.")).toMatchObject({ sansEffet: true });
    expect(lireReponseAgenda(f, "merci")).toMatchObject({ sansEffet: true });
    const c = { cle: "comparaison", choix: ["Oui, compare", "Non"] };
    expect(lireReponseAgenda(c, "oui vas-y")).toEqual({ valeur: "Oui, compare", sansEffet: false });
    expect(lireReponseAgenda(c, "non")).toMatchObject({ sansEffet: true });
    expect(lireReponseAgenda({ cle: "destinataire", choix: ["C'est pour moi"] }, "À Amel")).toEqual({ valeur: "À Amel", sansEffet: false });
  });

  it("précision transmise et accusé : la valeur redite, l'impact dit, jamais « j'attends »", () => {
    expect(precisionDeLaReponse("format", "PDF")).toBe("Format de rendu voulu : PDF.");
    expect(precisionDeLaReponse("comparaison", "Oui, compare")).toContain("l'an dernier");
    expect(precisionDeLaReponse("destinataire", "Amel")).toContain("rien ne part sans confirmation");
    expect(accuseDeReponse("PDF", "mineur")).toMatch(/rendu ainsi/);
    expect(accuseDeReponse("le trimestre", "majeur")).toMatch(/le travail en tient compte/);
    for (const i of ["majeur", "mineur", null] as const) expect(accuseDeReponse("x", i)).not.toMatch(/attend/);
  });

  it("l'avancement : étapes réelles, sous-missions, durée estimée d'après l'historique", () => {
    expect(estimerDureeMs([1000, 2000])).toBeNull();
    expect(estimerDureeMs([60_000, 80_000, 90_000, 70_000])).toBe(75_000);
    expect(phraseAvancement({ etapes: ["Annuaire consulté", "Ventes lues"], ecouleMs: 20_000, estimeMs: 75_000, sousMissions: null }))
      .toBe("2 étapes faites (dernière : ventes lues), d'habitude, encore environ 1 minute.");
  });
});

describe("classer un énoncé pendant un travail — déterministe quand c'est évident, sinon le classifieur", () => {
  const format = { id: "a1", cle: "format", choix: ["Excel", "PDF", "Peu importe"], impact: "mineur" as const, forme: "fichier" as const };
  const periode = { id: "a2", cle: "periode", choix: ["Ce mois-ci", "Le trimestre", "L'année"], impact: "majeur" as const, forme: null };

  it("la réponse à la question posée : un choix proposé, avec l'impact de la question", () => {
    expect(classerSansModele("En PDF", format)).toMatchObject({ nature: "precision", impact: "mineur", forme: "fichier", repondA: "a1", source: "regle" });
    expect(classerSansModele("le trimestre", periode)).toMatchObject({ nature: "precision", impact: "majeur", repondA: "a2" });
    expect(classerSansModele("peu importe", format)).toMatchObject({ nature: "precision", repondA: "a1" });
  });

  it("une consigne de forme est une précision MINEURE ; une politesse, de la conversation — sans modèle", () => {
    expect(classerSansModele("fais-le plus court", null)).toMatchObject({ nature: "precision", impact: "mineur", forme: "texte" });
    expect(classerSansModele("mets-le en Excel", null)).toMatchObject({ nature: "precision", impact: "mineur", forme: "fichier" });
    expect(classerSansModele("envoie-le à Amel", null)).toMatchObject({ nature: "precision", impact: "mineur", forme: "destinataire" });
    expect(classerSansModele("merci", null)).toMatchObject({ nature: "conversation" });
  });

  it("ce qui n'est pas évident va au classifieur — jamais « précision par défaut »", () => {
    expect(classerSansModele("et pour les clients d'Oran, il en est où le recouvrement ?", periode)).toBeNull();
    expect(classerSansModele("Combien de clients à Oran ?", null)).toBeNull();
    expect(classerSansModele("plutôt sur 2025", null)).toBeNull();
  });

  it("la sortie du classifieur : JSON strict, valeurs connues ; illisible → null (le repli décide, et le dit)", () => {
    expect(lireClassement('{"nature":"autre_demande","impact":null,"forme":null,"consigne":"clients à Oran"}')).toEqual({ nature: "autre_demande", impact: null, forme: null, consigne: "clients à Oran" });
    expect(lireClassement('```json\n{"nature":"precision","impact":"majeur","forme":null,"consigne":"Seulement Oran."}\n```')).toMatchObject({ nature: "precision", impact: "majeur" });
    expect(lireClassement('{"nature":"precision","impact":"mineur","forme":"bizarre","consigne":"plus formel"}')).toMatchObject({ impact: "mineur", forme: "texte" });
    expect(lireClassement("Je pense que c'est une précision.")).toBeNull();
    expect(lireClassement('{"nature":"precision","consigne":"x"}')).toBeNull();
    expect(classerParRepli("Combien de clients à Oran ?")).toMatchObject({ nature: "autre_demande", source: "repli" });
    expect(classerParRepli("plutôt sur 2025")).toMatchObject({ nature: "precision", impact: "majeur", source: "repli" });
  });

  it("la voie d'un message écrit selon son classement", () => {
    const precision = { nature: "precision" as const, impact: "majeur" as const, forme: null, consigne: "x", source: "classifieur" as const };
    const autre = { nature: "autre_demande" as const, impact: null, forme: null, consigne: "x", source: "classifieur" as const };
    const r = { travailLongMs: 8_000 };
    expect(voieDuClassement(precision, { travailEnCoursDepuisMs: 2_000, questionEnAttente: false, ...r })).toBe("precision");
    expect(voieDuClassement(precision, { travailEnCoursDepuisMs: null, questionEnAttente: true, ...r })).toBe("precision");
    expect(voieDuClassement(autre, { travailEnCoursDepuisMs: 20_000, questionEnAttente: true, ...r })).toBe("parallele");
    expect(voieDuClassement(autre, { travailEnCoursDepuisMs: 2_000, questionEnAttente: false, ...r })).toBe("suite");
  });
});
