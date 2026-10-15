import { describe, expect, it } from "vitest";
import { changementDeNumeroSeul, champsDifferents, normaliserPourComparer, phraseNumeroSeul } from "./numero-seul";

/** « SEUL LE NUMÉRO CHANGE » — décidé en comparant l'enregistré et le soumis (Direction, 14/10/2026). */
const spec = {
  numero: "040/DG/2026", date: "2026-03-10", tiers: { nom: "Imprimerie Atlas", adresse: "Blida", email: null },
  lignes: [{ designation: "Fiches", quantite: 100, prixUnitaire: 250, remise: 0, tva: null, details: [] }],
  tvaDefaut: 0.19, remiseGlobale: null, modePaiement: "VIREMENT", objet: "Impression", contact: null, taxes: [], livraison: { adresse: "Siège" },
  notes: undefined, signataire: { nom: "Amel Haddad", qualite: "Directrice" }, mentionsPiece: null,
  // Dérivés du profil : jamais comparés.
  emetteur: { nom: "Labo" }, piedDePage: ["RC 16/00"], couleur: "#1B7F79",
};

describe("seul le numéro change ?", () => {
  it("la même pièce, écrite autrement (espaces, vides, remise 0, ordre des clés), ne change que par son numéro", () => {
    const soumis = {
      ...spec, numero: "040/DG/2026",
      tiers: { adresse: " Blida ", nom: "Imprimerie  Atlas" },
      lignes: [{ designation: "Fiches ", quantite: 100, prixUnitaire: 250, remise: null, details: null }],
      taxes: null, notes: "", contact: { nom: "", telephone: null },
      emetteur: { nom: "Autre carte" }, piedDePage: [], couleur: "#000",
    };
    expect(changementDeNumeroSeul(spec, soumis, { numeroChange: true })).toEqual({ seul: true, autres: [] });
    // Sans changement de numéro, ce n'est pas un « numéro seul » (rien ne change du tout).
    expect(changementDeNumeroSeul(spec, soumis, { numeroChange: false }).seul).toBe(false);
  });

  it("le moindre autre champ, ou un autre papier, fait une révision ordinaire — et il est nommé", () => {
    const prix = { ...spec, lignes: [{ ...spec.lignes[0], prixUnitaire: 251 }] };
    expect(changementDeNumeroSeul(spec, prix, { numeroChange: true })).toEqual({ seul: false, autres: ["lignes"] });
    expect(changementDeNumeroSeul(spec, { ...spec, date: "2026-03-11" }, { numeroChange: true }).autres).toEqual(["date"]);
    expect(changementDeNumeroSeul(spec, { ...spec, tiers: { ...spec.tiers, nom: "Autre" } }, { numeroChange: true }).autres).toEqual(["tiers"]);
    expect(changementDeNumeroSeul(spec, { ...spec, notes: "Livrer le matin" }, { numeroChange: true }).autres).toEqual(["notes"]);
    expect(changementDeNumeroSeul(spec, spec, { numeroChange: true, papierChange: true })).toEqual({ seul: false, autres: ["papier en-tête"] });
    // Une TVA à 0 n'est pas « aucune TVA » (seule la remise nulle vaut rien).
    expect(changementDeNumeroSeul(spec, { ...spec, tvaDefaut: 0 }, { numeroChange: true }).autres).toEqual(["tvaDefaut"]);
  });

  it("la normalisation et la comparaison générique (fiche d'un BC déposé)", () => {
    expect(normaliserPourComparer({ b: " x ", a: [], c: { d: null } })).toEqual({ b: "x" });
    expect(champsDifferents({ title: "BC", amount: 50000, parties: ["a", "b"] }, { title: "BC ", amount: 50000.0000001, parties: ["a", "b"] }, ["title", "amount", "parties"])).toEqual([]);
    expect(champsDifferents({ amount: 50000 }, { amount: 50001 }, ["amount"])).toEqual(["amount"]);
  });

  it("ce que l'écran dit : signé, la signature est conservée et la copie signée reste la pièce signée", () => {
    expect(phraseNumeroSeul({ signe: true })).toMatch(/signature des Finances est conservée/);
    expect(phraseNumeroSeul({ signe: false })).not.toMatch(/signature/);
  });
});
