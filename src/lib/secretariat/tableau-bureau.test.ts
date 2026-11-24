import { describe, expect, it } from "vitest";
import type { LigneBureau } from "./ligne-bureau";
import { correspondRecherche, echeanceAffichee, masqueeParDefaut, periodeCourte } from "./tableau-bureau";
import { blocsDeLaDemande, champsRestants } from "./blocs-demande";

const JOUR = 86_400_000;
const MAINTENANT = Date.parse("2026-11-24T10:00:00.000Z");
const ligne = (p: Partial<LigneBureau>): LigneBureau => ({
  cle: "x", famille: "demande", type: "Hôtel", objet: "Dr A. Bouzid — Oran, 3 nuits", reference: "PEC-2026-118", demandeur: "Nadia H.",
  dates: null, etat: "A_PRENDRE", chezQui: null, echeance: null, depuis: new Date(MAINTENANT - 2 * JOUR).toISOString(), href: "/x", ...p,
});

describe("le tableau du bureau — l'affichage", () => {
  it("la colonne Dates : même mois, mois différents, un seul jour", () => {
    expect(periodeCourte("2026-12-11", "2026-12-14")).toBe("11 → 14 déc.");
    expect(periodeCourte("2026-11-28", "2026-12-03")).toBe("28 nov. → 3 déc.");
    expect(periodeCourte("2026-12-11", null)).toBe("11 déc.");
    expect(periodeCourte(null, null)).toBeNull();
  });
  it("la colonne Échéance : rouge et « en retard » si le jour est passé, sinon la date ; sans échéance, « depuis n j » ; close, « — »", () => {
    expect(echeanceAffichee(ligne({ echeance: "2026-11-22T00:00:00.000Z" }), MAINTENANT)).toEqual({ texte: "22 nov. · en retard", retard: true });
    expect(echeanceAffichee(ligne({ echeance: "2026-11-24T00:00:00.000Z" }), MAINTENANT)).toEqual({ texte: "24 nov.", retard: false });
    expect(echeanceAffichee(ligne({}), MAINTENANT)).toEqual({ texte: "depuis 2 j", retard: false });
    expect(echeanceAffichee(ligne({ etat: "TERMINEE" }), MAINTENANT)).toEqual({ texte: "—", retard: false });
    expect(echeanceAffichee(ligne({ etat: "TERMINEE", echeance: "2026-11-01T00:00:00.000Z" }), MAINTENANT).retard, "une close n'est jamais en retard").toBe(false);
  });
  it("les closes de plus de 30 jours se masquent ; les ouvertes jamais", () => {
    expect(masqueeParDefaut(ligne({ etat: "TERMINEE", termineeLe: new Date(MAINTENANT - 40 * JOUR).toISOString() }), MAINTENANT)).toBe(true);
    expect(masqueeParDefaut(ligne({ etat: "ANNULEE", termineeLe: new Date(MAINTENANT - 5 * JOUR).toISOString() }), MAINTENANT)).toBe(false);
    expect(masqueeParDefaut(ligne({ etat: "EN_COURS", depuis: new Date(MAINTENANT - 400 * JOUR).toISOString() }), MAINTENANT)).toBe(false);
  });
  it("UNE recherche : objet, référence, demandeur, personne — sans accent ni casse, tous les mots", () => {
    const l = ligne({ recherche: "Pr Mansouri" });
    expect(correspondRecherche(l, "hotel oran")).toBe(true);
    expect(correspondRecherche(l, "pec-2026-118")).toBe(true);
    expect(correspondRecherche(l, "nadia")).toBe(true);
    expect(correspondRecherche(l, "mansouri")).toBe(true);
    expect(correspondRecherche(l, "constantine")).toBe(false);
    expect(correspondRecherche(l, "  ")).toBe(true);
  });
});

describe("la fiche d'une demande — les blocs de son type", () => {
  it("un déplacement : trajet, dates, billet / hôtel / nuits, agence ; ses autres champs restent listés", () => {
    const f = { villeDepart: "Alger", villeArrivee: "Oran", dateDepart: "2026-12-11", dateRetour: "2026-12-14", billet: "oui", hotel: "oui", nbNuits: "3", agence: "Atlas", budget: "50000" };
    expect(blocsDeLaDemande("TRAVEL", f).map((b) => [b.titre, b.valeur])).toEqual([
      ["Trajet", "Alger → Oran"], ["Dates", "11 → 14 déc."], ["Billet · hôtel", "Billet · Hôtel · 3 nuits"], ["Agence", "Atlas"],
    ]);
    expect(champsRestants("TRAVEL", f)).toEqual(["budget"]);
  });
  it("courrier, signature, paiement : les blocs nommés par la décision", () => {
    expect(blocsDeLaDemande("MAIL", { destinataire: "ANPP", modeEnvoi: "depot" }).map((b) => b.titre)).toEqual(["Destinataire", "Organisme", "Objet", "Mode d'envoi"]);
    expect(blocsDeLaDemande("MAIL", { modeEnvoi: "depot" })[3]!.valeur).toBe("Dépôt physique");
    expect(blocsDeLaDemande("SIGNATURE", { action: "cachet" }).map((b) => b.titre)).toEqual(["Document", "Action", "Signataire", "Exemplaires"]);
    const p = blocsDeLaDemande("PAYMENT", { beneficiaire: "Hôtel Sheraton", montant: "120000", devise: "DZD", factureDispo: "oui" });
    expect(p.map((b) => [b.titre, b.valeur])).toEqual([["Bénéficiaire", "Hôtel Sheraton"], ["Montant", `${(120000).toLocaleString("fr-FR")} DZD`], ["Date souhaitée", "Non précisée"], ["Facture", "Disponible"]]);
  });
  it("un type sans blocs garde la liste générique", () => {
    expect(blocsDeLaDemande("OTHER", { x: 1 })).toEqual([]);
    expect(blocsDeLaDemande("DRIVER", { destination: "Banque" })).toEqual([]);
    expect(champsRestants("GUEST_VISA", { nom: "Pr X", pays: "FR" })).toEqual(["nom", "pays"]);
  });
});
