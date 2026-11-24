import { describe, expect, it } from "vitest";
import {
  alerteCourte, alertesDeLaDemande, etatCourt, etatEnvoyee, etiquetteDeLaDemande, genreDeLaDemande, libelleAccepter,
  libelleDecision, ligneInitiale, messageDecision, motifsDeRefus, MOTIFS_REFUS_COMMUNS, nomCourt, panneauDeLAdresse,
  phraseApres, phraseAvantApres, phraseEcheance, questionPosee, segmentsBv, type BlocBv,
} from "./centre-affichage";

/**
 * LE CENTRE DE VALIDATIONS, UN SEUL ÉCRAN — les règles d'affichage (maquette validée le 24/11/2026). Rien ici ne décide
 * d'un droit : ce que la ligne et la fiche DISENT.
 */

const NOW = new Date("2026-11-24T10:00:00Z");

describe("la famille d'une demande et son étiquette", () => {
  it("se lit sur la nature posée par le code, puis sur l'objet", () => {
    expect(genreDeLaDemande({ objectType: "REGULATORY_BV_25" })).toBe("BV");
    expect(genreDeLaDemande({ objectType: "REGULATORY_BV_75" })).toBe("BV");
    expect(genreDeLaDemande({ objectType: "BON_DE_COMMANDE", entityType: "LEGAL_DOCUMENT" })).toBe("BC");
    expect(genreDeLaDemande({ objectType: "PREVALIDATION_BC" })).toBe("BC");
    expect(genreDeLaDemande({ objectType: "INFO_MED_DIRECTEUR_OPS" })).toBe("IM");
    expect(genreDeLaDemande({ objectType: null, entityType: "MEDICAL_INFO_DECLARATION" })).toBe("IM");
    // Une validation de PIÈCE d'une demande du secrétariat : on valide la pièce, pas la demande.
    expect(genreDeLaDemande({ entityType: "ADMIN_REQUEST", documentId: "d1" })).toBe("PIECE");
    expect(genreDeLaDemande({ entityType: "ADMIN_REQUEST" })).toBe("SEC");
    expect(genreDeLaDemande({ objectType: "Achat matériel" })).toBe("AUTRE");
  });

  it("l'étiquette dit la part du BV ; à défaut, le module d'origine — jamais une clé brute", () => {
    expect(etiquetteDeLaDemande("BV", "REGULATORY_BV_25", "Regulatory")).toBe("BV 25 %");
    expect(etiquetteDeLaDemande("BV", "REGULATORY_BV_75", "Regulatory")).toBe("BV 75 %");
    expect(etiquetteDeLaDemande("BC", "BON_DE_COMMANDE", "Bons de commande")).toBe("BC");
    expect(etiquetteDeLaDemande("SEC", null, "Demandes administratives")).toBe("Secrétariat");
    expect(etiquetteDeLaDemande("IM", "INFO_MED_DIRECTEUR_OPS", "x")).toBe("Info. médicale");
    expect(etiquetteDeLaDemande("PIECE", null, "x")).toBe("Pièce");
    expect(etiquetteDeLaDemande("AUTRE", null, "Legal")).toBe("Legal");
    expect(etiquetteDeLaDemande("AUTRE", null, "  ")).toBe("Validation");
  });
});

describe("l'état court de la ligne", () => {
  const base = { demandeLe: "2026-11-21T09:00:00Z", depuis: "2026-11-21T09:00:00Z" };

  it("la question posée l'emporte : la dernière parole est la mienne", () => {
    expect(etatCourt({ ...base, echeance: "2026-11-20T00:00:00Z" }, NOW, true)).toEqual({ texte: "Question posée", ton: "bleu" });
  });

  it("le retard en rouge, l'échéance à venir, sinon l'ancienneté de l'attente", () => {
    expect(etatCourt({ ...base, echeance: "2026-11-22T00:00:00Z" }, NOW)).toEqual({ texte: "en retard de 2 j", ton: "rouge" });
    expect(etatCourt({ ...base, echeance: "2026-11-28T00:00:00Z" }, NOW)).toEqual({ texte: "avant le 28 nov.", ton: "neutre" });
    expect(etatCourt({ ...base, echeance: null }, NOW)).toEqual({ texte: "depuis 3 j", ton: "neutre" });
    expect(etatCourt({ demandeLe: "2026-11-24T08:00:00Z", depuis: null, echeance: null }, NOW)).toEqual({ texte: "aujourd'hui", ton: "neutre" });
  });

  it("l'attente se compte depuis MON tour (séquentiel), pas depuis le dépôt", () => {
    expect(etatCourt({ demandeLe: "2026-11-01T09:00:00Z", depuis: "2026-11-23T09:00:00Z", echeance: null }, NOW).texte).toBe("depuis 1 j");
  });

  it("l'échéance de la fiche", () => {
    expect(phraseEcheance(null, NOW)).toBe("Sans échéance");
    expect(phraseEcheance("2026-11-28T00:00:00Z", NOW)).toBe("Avant le 28 nov.");
    expect(phraseEcheance("2026-11-22T00:00:00Z", NOW)).toBe("Échéance dépassée (22 nov.)");
  });
});

describe("les alertes", () => {
  const base = { demandeLe: "2026-11-21T09:00:00Z", depuis: "2026-11-21T09:00:00Z", echeance: null as string | null };

  it("aucune alerte pour une demande ordinaire", () => {
    expect(alertesDeLaDemande(base, NOW)).toEqual([]);
    expect(alerteCourte([])).toBeNull();
  });

  it("le retard est rouge ; l'intérim et la resoumission se disent avant le bouton", () => {
    const a = alertesDeLaDemande({ ...base, echeance: "2026-11-22T00:00:00Z", pourLeCompteDe: "Karim Saïdi", version: 2 }, NOW);
    expect(a.map((x) => x.titre)).toEqual(["En retard de 2 jours", "Intérim pour Karim Saïdi", "Resoumise après correction"]);
    expect(alerteCourte(a)).toEqual({ texte: "En retard de 2 jours · Intérim pour Karim Saïdi · Resoumise après correction", ton: "rouge" });
  });

  it("une demande sans échéance qui dort depuis 7 jours se signale", () => {
    const a = alertesDeLaDemande({ ...base, depuis: "2026-11-16T09:00:00Z" }, NOW);
    expect(a).toEqual([{ titre: "Sans décision depuis 8 jours", detail: "aucune échéance ne la signale", ton: "orange" }]);
  });

  it("un BV qui dépasserait son budget, ou qu'aucune enveloppe ne compterait", () => {
    const depasse: BlocBv = { etat: "LU", part: "25", categorie: "Regulatory 2026 › BV 25 %", periode: "", alloue: 1000, consomme: 600, engage: 200, demande: 300, disponibleAvant: 200, disponibleApres: -100, prevision75: null };
    expect(alertesDeLaDemande({ ...base, bv: depasse }, NOW)[0]).toMatchObject({ titre: "Budget BV dépassé", ton: "rouge" });
    expect(alertesDeLaDemande({ ...base, bv: { etat: "SANS_ENVELOPPE", part: "75" } }, NOW)[0]).toMatchObject({ titre: "Aucune enveloppe BV", ton: "orange" });
    expect(alertesDeLaDemande({ ...base, bv: { etat: "NON_VISIBLE", part: "25", categorie: "x" } }, NOW)).toEqual([]);
  });
});

describe("les gestes", () => {
  it("les motifs du genre d'abord, puis les communs", () => {
    expect(motifsDeRefus("BV")).toEqual(["Dossier pas prêt pour la présoumission", ...MOTIFS_REFUS_COMMUNS]);
    expect(motifsDeRefus("AUTRE")).toEqual([...MOTIFS_REFUS_COMMUNS]);
  });

  it("le bouton d'accord nomme ce qu'on accepte", () => {
    expect(libelleAccepter("BV")).toBe("Accepter le BV");
    expect(libelleAccepter("BC")).toBe("Accepter le BC");
    expect(libelleAccepter("IM")).toBe("Accepter : déclarer");
    expect(libelleAccepter("PIECE")).toBe("Accepter la pièce");
    expect(libelleAccepter("SEC")).toBe("Accepter");
  });

  it("ce qui suit l'accord : le validateur suivant, l'engagement du BV, la signature du BC", () => {
    const l = { montant: 1_850_000, demandeur: "Yasmine Benali", suivant: null as string | null, objectType: "REGULATORY_BV_25" };
    expect(phraseApres({ ...l, genre: "BV" })).toMatch(/^Accepté : 1\s850\s000(,00)?\sDZD engagés au budget BV 25 %\./);
    expect(phraseApres({ ...l, genre: "BC" })).toBe("Accepté : le bon de commande part à la signature.");
    expect(phraseApres({ ...l, genre: "SEC" })).toBe("Accepté : Yasmine B. est prévenu.");
    expect(phraseApres({ ...l, genre: "SEC", suivant: "Nadia Brahimi" })).toBe("Accepté : la demande passe à Nadia Brahimi.");
  });

  it("le bandeau qui suit la décision", () => {
    const l = { objet: "Imprimantes RH", demandeur: "Amina Kaci", genre: "SEC" as const, montant: 145_000, suivant: null };
    expect(messageDecision("APPROVED", l)).toBe("Accepté : Imprimantes RH — Amina K. est prévenu.");
    expect(messageDecision("REJECTED", l, "Non prioritaire")).toBe("Refusé : Imprimantes RH — Amina K. lit votre motif : « Non prioritaire ».");
    expect(messageDecision("CHANGES_REQUESTED", l)).toBe("Renvoyé pour correction : Imprimantes RH — la demande revient chez Amina K. avec votre question.");
  });

  it("la question posée : la dernière parole est la mienne", () => {
    const m = (deMoi: boolean) => ({ id: "x", auteur: "a", deMoi, le: "2026-11-21T09:00:00Z", texte: "t" });
    expect(questionPosee([])).toBe(false);
    expect(questionPosee([m(true)])).toBe(true);
    expect(questionPosee([m(true), m(false)])).toBe(false);
  });

  it("le nom court", () => {
    expect(nomCourt("Yasmine Benali")).toBe("Yasmine B.");
    expect(nomCourt("Dr Lamia Hadj Ali")).toBe("Dr A.");
    expect(nomCourt("Karim")).toBe("Karim");
    expect(nomCourt("")).toBe("le demandeur");
  });
});

describe("le budget d'un BV, avant → après", () => {
  const b: Extract<BlocBv, { etat: "LU" }> = {
    etat: "LU", part: "25", categorie: "Regulatory 2026 › BV 25 %", periode: "", alloue: 10_000_000, consomme: 3_100_000,
    engage: 1_150_000, demande: 1_850_000, disponibleAvant: 5_750_000, disponibleApres: 3_900_000, prevision75: null,
  };

  it("quatre segments en % de l'alloué", () => {
    expect(segmentsBv(b).map((s) => [s.cle, s.pct])).toEqual([["consomme", 31], ["engage", 11.5], ["demande", 18.5], ["disponible", 39]]);
  });

  it("un dépassement ne fait pas déborder la barre : la base devient le total", () => {
    const s = segmentsBv({ ...b, alloue: 1000, consomme: 800, engage: 0, demande: 400, disponibleAvant: 200, disponibleApres: -200 });
    expect(s.reduce((t, x) => t + x.pct, 0)).toBeLessThanOrEqual(100);
    expect(s.find((x) => x.cle === "disponible")!.pct).toBe(0);
  });

  it("la phrase avant → après", () => {
    expect(phraseAvantApres(b)).toMatch(/^Disponible 5\s750\s000(,00)? → 3\s900\s000(,00)?\sDZD$/);
  });
});

describe("le menu ⋯ et l'adresse", () => {
  it("la décision d'une étape, pour « Déjà décidés »", () => {
    expect(libelleDecision("APPROVED", null)).toEqual({ texte: "Accepté", accord: true });
    expect(libelleDecision("REJECTED", "Non prioritaire")).toEqual({ texte: "Refusé · Non prioritaire", accord: false });
    expect(libelleDecision("CHANGES_REQUESTED", "x")).toEqual({ texte: "Renvoyé pour correction", accord: false });
  });

  it("l'état d'une demande envoyée", () => {
    expect(etatEnvoyee("PENDING", "2026-11-22T09:00:00Z", null, NOW)).toEqual({ texte: "En attente · 2 j", ton: "orange" });
    expect(etatEnvoyee("APPROVED", "2026-11-10T09:00:00Z", "2026-11-19T09:00:00Z", NOW).texte).toBe("Acceptée le 19 nov.");
    expect(etatEnvoyee("CHANGES_REQUESTED", "2026-11-10T09:00:00Z", null, NOW).texte).toBe("À corriger");
  });

  it("le panneau qu'une adresse ouvre — tout autre mot ramène à la file", () => {
    expect(panneauDeLAdresse("decides")).toBe("decides");
    expect(panneauDeLAdresse("regles")).toBe("regles");
    expect(panneauDeLAdresse("autre")).toBeNull();
    expect(panneauDeLAdresse(undefined)).toBeNull();
  });

  it("la ligne ouverte : l'étape des notifications (`?focus=`), la demande (`?demande=`), sinon la première", () => {
    const file = [{ stepId: "s1", requestId: "r1" }, { stepId: "s2", requestId: "r2" }];
    expect(ligneInitiale(file, "s2", null)).toBe("s2");
    expect(ligneInitiale(file, null, "r2")).toBe("s2");
    expect(ligneInitiale(file, "inconnue", null)).toBe("s1");
    expect(ligneInitiale([], "s1", null)).toBeNull();
  });
});
