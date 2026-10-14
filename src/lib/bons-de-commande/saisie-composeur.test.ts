import { describe, expect, it } from "vitest";
import { lireSaisieDuComposeur, refusDeLaSaisie } from "./saisie-composeur";
import { appliquerCorrections, brouillonCorrige, brouillonNeuf, brouillonPerime, correctionsDuBrouillon, lireBrouillon, lireCorrections, type DemandeCorrigeable } from "./brouillon";
import { formulaireDuComposeur } from "./composeur-test-outils";
import type { ValeursComposables } from "@/lib/legal/piece-emise";

/**
 * L'APERÇU « ULTRA COMPLET » D'UN BC (Direction, 14/10/2026) — la règle pure : UNE lecture du formulaire du composeur, gardée
 * telle quelle sur le brouillon (aller-retour JSON sans perte), et appliquée champ par champ à la demande composée du devis.
 */
const VALEURS: ValeursComposables = {
  tiers: { nom: "Hôtel Le Méridien", adresse: "Front de mer\nOran", telephone: "041 11 22 33", email: "c@m.dz", rc: "31/00-1", nif: "0009", ai: "31099", nis: "00093" },
  champs: {
    numeroClient: "", date: "2026-11-03", echeance: "", validiteJours: "", objet: "Congrès", referenceAmont: "DEV-77", referenceAmontDate: "2026-09-28",
    contactNom: "Mme Benali", contactTelephone: "0555", livraisonAdresse: "Sheraton", livraisonDelai: "15 jours", livraisonDate: "2026-11-20",
    modePaiement: "CHEQUE", conditionsPaiement: "60 jours", tvaDefaut: "9", remiseGlobale: "5", notes: "Notes",
  },
  lignes: [
    { designation: "Prestations", unite: "", details: "", quantite: "", prix: "", remise: "", tva: "", section: true },
    { designation: "Salle", unite: "jour", details: "Plénière\nVidéo", quantite: "1", prix: "200 000", remise: "10", tva: "19", section: false },
  ],
  taxes: [{ libelle: "Taxe Pub", taux: "2" }],
  letterheadId: "",
  emetteur: { adresse: "Siège", telephone: "021", email: "a@e.dz" },
  signataire: { nom: "Amel Haddad", qualite: "Directrice" },
  mentions: "Franco de port.\nRéclamation sous 8 jours.",
};

describe("la saisie du composeur — une lecture, tous les champs", () => {
  it("lit CHAQUE catégorie : fournisseur complet, lignes (unité, détails, section, remise, TVA), dates, paiement, taxes, livraison, contact, papier, émetteur, signataire, mentions", () => {
    const s = lireSaisieDuComposeur(formulaireDuComposeur(VALEURS, { letterheadId: "papier-1" }));
    expect(s.tiers).toEqual({ nom: "Hôtel Le Méridien", adresse: "Front de mer\nOran", telephone: "041 11 22 33", email: "c@m.dz", rc: "31/00-1", nif: "0009", ai: "31099", nis: "00093" });
    expect(s.lignes).toEqual([
      expect.objectContaining({ designation: "Prestations", section: true, quantite: 0, prixUnitaire: 0, unite: null }),
      expect.objectContaining({ designation: "Salle", unite: "jour", details: ["Plénière", "Vidéo"], quantite: 1, prixUnitaire: 200_000, remise: 0.1, tva: 0.19 }),
    ]);
    expect(s).toMatchObject({
      date: "2026-11-03", objet: "Congrès", referenceAmont: "DEV-77", referenceAmontDate: "2026-09-28", modePaiement: "CHEQUE", conditionsPaiement: "60 jours",
      tvaDefaut: 0.09, remiseGlobale: 0.05, notes: "Notes", taxes: [{ libelle: "Taxe Pub", taux: 0.02 }],
      livraison: { adresse: "Sheraton", delai: "15 jours", date: "2026-11-20" }, contact: { nom: "Mme Benali", telephone: "0555" },
      letterheadId: "papier-1", coordonneesEmetteur: { adresse: "Siège", telephone: "021", email: "a@e.dz" },
      signataire: { nom: "Amel Haddad", qualite: "Directrice" }, mentions: ["Franco de port.", "Réclamation sous 8 jours."],
    });
    expect(refusDeLaSaisie(s)).toBeNull();
  });

  it("une clé ABSENTE garde ; présente et vide, elle efface ; les coordonnées « 0 » rendent celles de la société", () => {
    const f = new FormData();
    f.set("notes", "");
    f.set("emetteurPersonnalise", "0");
    const s = lireSaisieDuComposeur(f);
    expect(s).toEqual({ notes: null, coordonneesEmetteur: null });
  });

  it("refuse une ligne sans désignation, une quantité illisible, une date mal écrite — en nommant la ligne", () => {
    expect(refusDeLaSaisie({ lignes: [{ designation: "", quantite: 1, prixUnitaire: 1 }] })).toMatch(/Ligne 1 : la désignation/);
    expect(refusDeLaSaisie({ lignes: [{ designation: "A", quantite: Number.NaN, prixUnitaire: 1 }] })).toMatch(/Ligne 1 : la quantité/);
    expect(refusDeLaSaisie({ lignes: [{ designation: "T", section: true, quantite: 0, prixUnitaire: 0 }] })).toMatch(/au moins une ligne chiffrée/);
    expect(refusDeLaSaisie({ livraison: { date: "20/11/2026" } })).toMatch(/AAAA-MM-JJ/);
  });
});

describe("le brouillon garde TOUT, et l'émission l'applique", () => {
  it("aller-retour JSON sans perte : ce qui est gardé en base est ce qui a été saisi", () => {
    const { lignes, ...corrections } = lireSaisieDuComposeur(formulaireDuComposeur(VALEURS, { letterheadId: "papier-1" }));
    const b = brouillonCorrige(brouillonNeuf({ itemId: "p", par: "u", parNom: null }), { lignes, ...corrections }, { lignesDuDevis: lignes!, par: "u" });
    const relu = lireBrouillon(JSON.parse(JSON.stringify(b)))!;
    expect(relu.corrections).toEqual(corrections);
    expect(lireCorrections(JSON.parse(JSON.stringify(corrections)))).toEqual(corrections);
    expect(relu.lignes?.[1]).toMatchObject({ unite: "jour", remise: 0.1, tva: 0.19, details: ["Plénière", "Vidéo"] });
    expect(brouillonPerime(relu, lignes!)).toBe(false);
    expect(brouillonPerime(relu, [lignes![1]!])).toBe(true);
  });

  it("les champs d'avant restent lus ; une correction du composeur les recouvre", () => {
    const ancien = { ...brouillonNeuf({ itemId: "p", par: "u", parNom: null }), objet: "Objet d'avant", notes: "Notes d'avant" };
    expect(correctionsDuBrouillon(ancien)).toEqual({ objet: "Objet d'avant", notes: "Notes d'avant" });
    expect(correctionsDuBrouillon({ ...ancien, corrections: { notes: null } })).toEqual({ objet: "Objet d'avant", notes: null });
  });

  it("appliquer : tout ce qui est écrit l'emporte ; le fournisseur se FUSIONNE (le RIB de l'annuaire reste), `null` retire le contact", () => {
    const duDevis: DemandeCorrigeable & { type: string } = {
      type: "BON_DE_COMMANDE", tiers: { nom: "Méridien", rib: "001 002", adresse: "Ancienne" }, lignes: [{ designation: "x", quantite: 1, prixUnitaire: 1 }],
      tvaDefaut: 0.19, objet: "Défaut", contact: { nom: "A", telephone: "1" }, livraison: { adresse: "Siège" },
    };
    const r = appliquerCorrections(duDevis, { tiers: { nom: "Méridien Oran", adresse: "Front de mer" }, tvaDefaut: 0.09, contact: null, livraison: { date: "2026-11-20" } });
    expect(r.tiers).toEqual({ nom: "Méridien Oran", rib: "001 002", adresse: "Front de mer" });
    expect(r).toMatchObject({ tvaDefaut: 0.09, objet: "Défaut", contact: null, livraison: { adresse: "Siège", date: "2026-11-20" }, type: "BON_DE_COMMANDE" });
    expect(appliquerCorrections(duDevis, { tiers: { nom: "  " } }).tiers.nom, "un nom vidé ne laisse pas un BC sans fournisseur").toBe("Méridien");
  });
});
