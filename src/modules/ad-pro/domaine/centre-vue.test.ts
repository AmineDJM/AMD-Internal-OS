import { describe, expect, it } from "vitest";
import type { LigneCentre } from "./centre";
import {
  alertesDeLaLigne, alerteCourte, cleLigne, CONTEXTE_VIDE, etatApresDecision, gestesDeLaForme, joursDAttente,
  montantsDuBC, natureDeLaLigne, natureDeLaLigneCourte, phraseApresDecision, phraseAttente, phraseSeuils, societesDuCentre,
  type ContexteLigneCentre,
} from "./centre-vue";

const ligne = (p: Partial<LigneCentre>): LigneCentre => ({
  kind: "SPONSORING", entityType: "SPONSORING", entityId: "s1", reference: "SPO-1", intitule: "Congrès", demandeur: "Sara",
  montant: 1_240_000, seuil: 1_000_000, forme: "TOTAL_DG", depuis: "2026-11-15T08:00:00.000Z", href: "/sponsoring/s1", ...p,
});
const ctx = (p: Partial<ContexteLigneCentre>): ContexteLigneCentre => ({ ...CONTEXTE_VIDE, ...p });

describe("la file du centre Ad & Pro", () => {
  it("une clé par ligne, la même partout", () => {
    expect(cleLigne(ligne({}))).toBe("SPONSORING:s1");
  });

  it("depuis quand elle attend : jours entiers, « aujourd'hui » le premier jour", () => {
    const maintenant = new Date("2026-11-24T10:00:00.000Z");
    expect(joursDAttente("2026-11-24T08:00:00.000Z", maintenant)).toBe(0);
    expect(joursDAttente("2026-11-15T08:00:00.000Z", maintenant)).toBe(9);
    // Une horloge en retard ne fabrique pas d'attente négative.
    expect(joursDAttente("2026-11-25T08:00:00.000Z", maintenant)).toBe(0);
    expect(phraseAttente(0)).toBe("aujourd'hui");
    expect(phraseAttente(9)).toBe("depuis 9 j");
  });

  it("la nature : le total, la nature Ad & Pro, ou « BC · nature » pour un bon de commande", () => {
    expect(natureDeLaLigne(ligne({}))).toBe("Total de la demande");
    expect(natureDeLaLigne(ligne({ forme: "VISA_CENTRE", kind: "CONSULTING" }))).toBe("Consulting");
    expect(natureDeLaLigne(ligne({ forme: "BC_POSTE" }))).toBe("Bon de commande");
    expect(natureDeLaLigneCourte(ligne({ forme: "BC_POSTE", kind: "CONGRESS_NATIONAL" }))).toBe("BC · Prise en charge nationale");
    expect(natureDeLaLigneCourte(ligne({ forme: "BC_LEGAL", kind: null }))).toBe("Bon de commande");
  });

  it("le seuil se dit UNE fois, en une phrase — 0 dit ce qu'il veut dire", () => {
    expect(phraseSeuils(1_000_000, 300_000)).toMatch(/^Passent ici les demandes dont le total dépasse 1\s000\s000 DZD, et les bons de commande au-dessus de 300\s000 DZD\.$/);
    expect(phraseSeuils(0, 0)).toMatch(/aucune demande \(seuil à 0\).*tous les bons de commande/);
  });
});

describe("les gestes du centre — ceux des actions serveur, pas ceux qu'on rêverait", () => {
  it("le TOTAL se valide ou se renvoie en révision ; il ne se refuse pas (statuerTotalDg n'a pas de refus)", () => {
    const g = gestesDeLaForme("TOTAL_DG");
    expect([g.ok, g.renvoyer, g.refuser, g.precision]).toEqual(["Valider le total", "Renvoyer en révision", null, true]);
  });

  it("le BC d'un POSTE se vise ou se refuse ; un BC du registre et une demande à visa ont trois issues", () => {
    expect(gestesDeLaForme("BC_POSTE")).toMatchObject({ ok: "Viser le BC", renvoyer: null, refuser: "Refuser" });
    expect(gestesDeLaForme("BC_LEGAL")).toMatchObject({ ok: "Viser le BC", renvoyer: "Renvoyer", refuser: "Refuser" });
    expect(gestesDeLaForme("VISA_CENTRE")).toMatchObject({ ok: "Autoriser le dépassement", renvoyer: "Renvoyer", refuser: "Refuser" });
  });

  it("une étape de circuit et l'ancien parcours promo se décident sur leur dossier : aucun geste ici", () => {
    for (const f of ["ETAPE_CIRCUIT", "ETAPE_PROMO", "BC_PROMO"] as const) expect(gestesDeLaForme(f).ok, f).toBeNull();
  });

  it("des motifs en un clic, propres aux demandes et aux BC", () => {
    expect(gestesDeLaForme("TOTAL_DG").motifs).toContain("Postes à réduire");
    expect(gestesDeLaForme("BC_LEGAL").motifs).toContain("Écart avec le devis retenu");
  });

  it("ce que devient la ligne juste après la décision", () => {
    expect(etatApresDecision("BC_POSTE", "VALIDER")).toBe("Visé");
    expect(etatApresDecision("TOTAL_DG", "VALIDER")).toBe("Validé");
    expect(etatApresDecision("VISA_CENTRE", "VALIDER")).toBe("Autorisé");
    expect(etatApresDecision("BC_LEGAL", "RENVOYER")).toBe("Renvoyé");
    expect(etatApresDecision("BC_POSTE", "REFUSER")).toBe("Refusé");
    expect(etatApresDecision("TOTAL_DG", "PRECISION")).toBe("Précision demandée");
    expect(phraseApresDecision("BC_LEGAL", "VALIDER", null)).toMatch(/signature des Finances/);
    expect(phraseApresDecision("TOTAL_DG", "RENVOYER", "Postes à réduire")).toBe("Renvoyé pour correction — « Postes à réduire ».");
  });
});

describe("les alertes — ce qu'on regarderait de toute façon avant de viser", () => {
  it("aucune alerte sur une ligne saine", () => {
    expect(alertesDeLaLigne(ligne({}), ctx({ budget: { ligne: "Marketing › Événements", disponible: 500_000, autres: 0 } }))).toEqual([]);
    expect(alerteCourte([])).toBeNull();
  });

  it("budget dépassé : le disponible de la ligne est NÉGATIF (il compte déjà l'engagé — on ne retranche pas deux fois)", () => {
    const a = alertesDeLaLigne(ligne({}), ctx({ budget: { ligne: "Marketing › PEC", disponible: -120_000, autres: 0 } }));
    expect(a.map((x) => x.titre)).toEqual(["Budget dépassé"]);
    expect(a[0].detail).toMatch(/Marketing › PEC/);
  });

  it("un BC au-dessus de l'accordé, et le devis le moins cher écarté", () => {
    const r = ligne({ forme: "BC_POSTE", montant: 382_500 });
    const c = ctx({
      accorde: 360_000,
      pieces: [{ nom: "Devis", documentId: "d1", nature: "DEVIS" }],
      devis: [
        { prestataire: "El Djazair", montant: 360_000, retenu: true, documentId: null },
        { prestataire: "Graphica", montant: 340_000, retenu: false, documentId: null },
        { prestataire: "Print Express", montant: 401_000, retenu: false, documentId: null },
      ],
    });
    const a = alertesDeLaLigne(r, c);
    expect(a.map((x) => x.titre)).toEqual(["BC au-dessus de l'accordé", "Devis le moins cher écarté"]);
    expect(a[1].detail).toMatch(/^Graphica/);
    expect(alerteCourte(a)).toBe("BC au-dessus de l'accordé · Devis le moins cher écarté");
  });

  it("un montant absent et un BC sans pièce se disent", () => {
    const a = alertesDeLaLigne(ligne({ forme: "BC_LEGAL", montant: null }), ctx({}));
    expect(a.map((x) => x.titre)).toEqual(["Montant non renseigné", "Aucune pièce"]);
  });

  it("devis → accordé → BC : l'écart est signalé, une demande n'a pas cette rangée", () => {
    const c = ctx({ accorde: 450_000, devis: [{ prestataire: "Atlas", montant: 450_000, retenu: true, documentId: null }] });
    expect(montantsDuBC(ligne({ forme: "BC_POSTE", montant: 470_000 }), c)).toEqual([
      { libelle: "Devis retenu", valeur: 450_000, ecart: false },
      { libelle: "Accordé", valeur: 450_000, ecart: false },
      { libelle: "BC", valeur: 470_000, ecart: true },
    ]);
    expect(montantsDuBC(ligne({}), c)).toEqual([]);
  });
});

describe("les pastilles de société", () => {
  it("« Toutes » d'abord, puis chaque société permise avec ce qui y attend ; une ligne sans société ne compte que sous « Toutes »", () => {
    const p = societesDuCentre([{ id: "a", nom: "Adventum" }, { id: "p", nom: "Pharmagène" }], [{ societeId: "a" }, { societeId: "a" }, { societeId: null }]);
    expect(p).toEqual([
      { cle: null, nom: "Toutes", enAttente: 3 },
      { cle: "a", nom: "Adventum", enAttente: 2 },
      { cle: "p", nom: "Pharmagène", enAttente: 0 },
    ]);
  });
});
