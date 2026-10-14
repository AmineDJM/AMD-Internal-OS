import { describe, expect, it } from "vitest";
import {
  montantDeLaDemande, lignesDeMontant, montantEstimeDesChamps, friseDeLaDemande, chezQuiDeLaDemande, gesteSuivant,
  dansLaTuile, enRetard, FAITS_VIDES, PRECEDENCE_MONTANT,
} from "./bureau";

const JOUR = 86_400_000;
const AUJ = Date.parse("2026-10-14T10:00:00.000Z");

describe("montantDeLaDemande — UN montant, le fait le plus avancé l'emporte", () => {
  it("la précédence est payé › imputé › facturé › engagé › validé › devis retenu › estimé", () => {
    expect(PRECEDENCE_MONTANT).toEqual(["PAYE", "IMPUTE", "FACTURE", "ENGAGE", "VALIDE", "DEVIS", "ESTIME"]);
    const tous = { ...FAITS_VIDES, estime: 10, devisRetenu: 20, valide: 30, engage: 40, facture: 50, impute: 60, paye: 70 };
    expect(montantDeLaDemande(tous)).toEqual({ montant: 70, etape: "PAYE" });
    expect(montantDeLaDemande({ ...tous, paye: null })).toEqual({ montant: 60, etape: "IMPUTE" });
    expect(montantDeLaDemande({ ...tous, paye: null, impute: null })).toEqual({ montant: 50, etape: "FACTURE" });
    expect(montantDeLaDemande({ ...FAITS_VIDES, estime: 70_000, valide: 76_000, engage: 76_000 })).toEqual({ montant: 76_000, etape: "ENGAGE" });
    expect(montantDeLaDemande({ ...FAITS_VIDES, estime: 70_000, valide: 76_000 })).toEqual({ montant: 76_000, etape: "VALIDE" });
    expect(montantDeLaDemande({ ...FAITS_VIDES, estime: 70_000, devisRetenu: 68_000 })).toEqual({ montant: 68_000, etape: "DEVIS" });
    expect(montantDeLaDemande({ ...FAITS_VIDES, estime: 70_000 })).toEqual({ montant: 70_000, etape: "ESTIME" });
  });

  it("un zéro, un négatif ou un NaN n'est pas un fait (« 0 DZD » se lirait gratuit) — on passe au suivant", () => {
    expect(montantDeLaDemande({ ...FAITS_VIDES, paye: 0, engage: -5, facture: Number.NaN, estime: 1200 })).toEqual({ montant: 1200, etape: "ESTIME" });
    expect(montantDeLaDemande(FAITS_VIDES)).toBeNull();
  });

  it("un paiement EN ATTENTE ne fait pas le montant « payé »", () => {
    expect(montantDeLaDemande({ ...FAITS_VIDES, enAttentePaiement: 9000, valide: 9000 })).toEqual({ montant: 9000, etape: "VALIDE" });
  });

  it("la carte « Montant » : une ligne par étape, et l'étape sans fait le dit au lieu d'un zéro", () => {
    const l = lignesDeMontant({ ...FAITS_VIDES, estime: 70_000, valide: 76_000, engage: 76_000, enAttentePaiement: 76_000 }, { estimePar: "Nadia R.", validePar: "Karim Z.", bcs: "049/DG/2026" });
    expect(l.map((x) => x.cle)).toEqual(["ESTIME", "VALIDE", "ENGAGE", "PAYE"]);
    expect(l.map((x) => x.montant)).toEqual([70_000, 76_000, 76_000, null]);
    expect(l[0].detail).toBe("saisi par Nadia R.");
    expect(l[2].detail).toBe("049/DG/2026");
    expect(l[3].detail).toMatch(/en attente des Finances/);
    const vide = lignesDeMontant(FAITS_VIDES);
    expect(vide.every((x) => x.montant === null)).toBe(true);
    expect(vide[2].detail).toBe("aucun bon de commande");
  });

  it("l'estimation se lit dans les champs saisis : montant, budget, puis lignes d'achat chiffrées", () => {
    expect(montantEstimeDesChamps({ montant: "124 300" })).toBe(124_300);
    expect(montantEstimeDesChamps({ budget: 45000 })).toBe(45_000);
    expect(montantEstimeDesChamps({ purchaseLines: [{ quantity: 2, unitPrice: 1500 }, { quantity: 1, unitPrice: null }] })).toBe(3000);
    expect(montantEstimeDesChamps({ purchaseLines: [{ quantity: 2, unitPrice: null }] })).toBeNull();
    expect(montantEstimeDesChamps(null)).toBeNull();
  });
});

describe("friseDeLaDemande — calculée de l'état, jamais posée à la main", () => {
  const base = { commencee: false, approbations: [], validationEnAttente: false, ordreEmis: false, demandeur: "Nadia R.", deposeeLe: "07/10", responsable: "Donna A." };
  const etats = (f: ReturnType<typeof friseDeLaDemande>) => f.map((e) => e.etat);

  it("nouvelle : déposée, validation sans objet, traitement à commencer", () => {
    const f = friseDeLaDemande({ ...base, statut: "NEW" });
    expect(etats(f)).toEqual(["FAITE", "SANS_OBJET", "COURANTE", "A_VENIR", "A_VENIR"]);
    expect(f[2].detail).toBe("à commencer");
    expect(f[0].detail).toBe("Nadia R. · 07/10");
  });

  it("en validation : la validation est l'étape courante, le traitement attend", () => {
    expect(etats(friseDeLaDemande({ ...base, statut: "AWAITING_VALIDATION", approbations: [{ status: "PENDING" }] })))
      .toEqual(["FAITE", "COURANTE", "A_VENIR", "A_VENIR", "A_VENIR"]);
  });

  it("validée puis en cours, puis en paiement, puis terminée", () => {
    const accord = [{ status: "APPROVED", decideur: "Karim Z.", le: "08/10" }];
    const enCours = friseDeLaDemande({ ...base, statut: "IN_PROGRESS", commencee: true, approbations: accord });
    expect(etats(enCours)).toEqual(["FAITE", "FAITE", "COURANTE", "A_VENIR", "A_VENIR"]);
    expect(enCours[1].detail).toBe("Karim Z. · 08/10");
    expect(etats(friseDeLaDemande({ ...base, statut: "AWAITING_PAYMENT", approbations: accord, ordreEmis: true })))
      .toEqual(["FAITE", "FAITE", "FAITE", "COURANTE", "A_VENIR"]);
    expect(etats(friseDeLaDemande({ ...base, statut: "DONE", approbations: accord, ordreEmis: true })))
      .toEqual(["FAITE", "FAITE", "FAITE", "FAITE", "FAITE"]);
    expect(etats(friseDeLaDemande({ ...base, statut: "DONE" }))).toEqual(["FAITE", "SANS_OBJET", "FAITE", "SANS_OBJET", "FAITE"]);
  });

  it("refusée par le validateur : « Validée » est refusée ; annulée : la dernière étape le dit", () => {
    expect(etats(friseDeLaDemande({ ...base, statut: "BLOCKED", approbations: [{ status: "REJECTED" }] }))[1]).toBe("REFUSEE");
    const annulee = friseDeLaDemande({ ...base, statut: "CANCELLED", commencee: true });
    expect(annulee[4]).toMatchObject({ libelle: "Annulée", etat: "REFUSEE" });
    expect(annulee[2].etat).toBe("FAITE");
  });
});

describe("chezQuiDeLaDemande et gesteSuivant", () => {
  const e = { responsable: "Donna A.", demandeur: "Sami B.", validateurEnAttente: "Karim Z." };
  it("chez qui attend la demande", () => {
    expect(chezQuiDeLaDemande({ ...e, statut: "NEW", responsable: null })).toEqual({ etape: "Assistante", personne: "non attribuée" });
    expect(chezQuiDeLaDemande({ ...e, statut: "AWAITING_VALIDATION" })).toEqual({ etape: "Validateur", personne: "Karim Z." });
    expect(chezQuiDeLaDemande({ ...e, statut: "AWAITING_PAYMENT" })).toEqual({ etape: "Finances", personne: "Comptabilité" });
    expect(chezQuiDeLaDemande({ ...e, statut: "IN_PROGRESS", bc: "A_VALIDER" })?.etape).toBe("Centre de validations");
    expect(chezQuiDeLaDemande({ ...e, statut: "IN_PROGRESS", bc: "A_SIGNER" })).toEqual({ etape: "Signature du BC", personne: "module Bons de commande" });
    expect(chezQuiDeLaDemande({ ...e, statut: "IN_PROGRESS", devisARetenir: true })?.etape).toBe("Demandeur");
    expect(chezQuiDeLaDemande({ ...e, statut: "IN_PROGRESS" })).toEqual({ etape: "Assistante", personne: "Donna A." });
    expect(chezQuiDeLaDemande({ ...e, statut: "DONE" })).toBeNull();
  });

  it("le geste principal : commencer, terminer, relancer, rouvrir — jamais sur une demande annulée", () => {
    const g = (statut: string, commencee = false, gere = true, estDemandeur = false) => gesteSuivant({ statut, commencee, gere, estDemandeur });
    expect(g("NEW")).toBe("COMMENCER");
    expect(g("IN_PROGRESS", false)).toBe("COMMENCER");
    expect(g("IN_PROGRESS", true)).toBe("TERMINER");
    expect(g("AWAITING_VALIDATION", true)).toBe("RELANCER");
    expect(g("AWAITING_PAYMENT", true)).toBe("RELANCER");
    expect(g("DONE", true)).toBe("ROUVRIR");
    expect(g("CANCELLED", true)).toBeNull();
    expect(g("IN_PROGRESS", true, false, true)).toBe("RELANCER");
    expect(g("DONE", true, false, true)).toBeNull();
    expect(g("IN_PROGRESS", true, false, false)).toBeNull();
  });
});

describe("tuiles-filtres", () => {
  it("en retard : ouverte, et le jour de l'échéance est passé — pas l'échéance du jour", () => {
    expect(enRetard({ statut: "IN_PROGRESS", echeance: "2026-10-12T00:00:00.000Z" }, AUJ)).toBe(true);
    expect(enRetard({ statut: "IN_PROGRESS", echeance: "2026-10-14T00:00:00.000Z" }, AUJ)).toBe(false);
    expect(enRetard({ statut: "DONE", echeance: "2026-10-01T00:00:00.000Z" }, AUJ)).toBe(false);
    expect(enRetard({ statut: "NEW", echeance: null }, AUJ)).toBe(false);
  });
  it("terminées sur 30 jours, et « en cours » compte une demande bloquée", () => {
    expect(dansLaTuile({ statut: "DONE", echeance: null, termineeLe: new Date(AUJ - 5 * JOUR).toISOString() }, "DONE_30", AUJ)).toBe(true);
    expect(dansLaTuile({ statut: "DONE", echeance: null, termineeLe: new Date(AUJ - 40 * JOUR).toISOString() }, "DONE_30", AUJ)).toBe(false);
    expect(dansLaTuile({ statut: "BLOCKED", echeance: null, termineeLe: null }, "IN_PROGRESS", AUJ)).toBe(true);
    expect(dansLaTuile({ statut: "NEW", echeance: null, termineeLe: null }, "NEW", AUJ)).toBe(true);
    expect(dansLaTuile({ statut: "NEW", echeance: null, termineeLe: null }, "AWAITING_PAYMENT", AUJ)).toBe(false);
  });
});
