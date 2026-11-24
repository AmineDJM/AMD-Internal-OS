import { describe, expect, it } from "vitest";
import {
  ETAPES_AGENCE_AU_BUREAU, etatDemandeDePiece, etatDemandeSecretariat, etatDevisPriseEnCharge, etatFicheVoyage, etatMaterielPromo,
  etatPosteAgence, typeLigneAgence,
} from "./etat-unifie";
import { ETATS_BUREAU } from "./ligne-bureau";
import { LIBELLE_ETAPE_FILE } from "@/modules/ad-pro/api";

/**
 * UN SEUL VOCABULAIRE D'ÉTAT (24/11/2026) — chaque statut de chaque famille, une fois. Un statut inconnu se lit « En cours »
 * (la ligne reste au tableau) ; toute traduction rend un état du contrat.
 */
describe("etat-unifie — les demandes du secrétariat", () => {
  it("chaque statut affiché a son état", () => {
    expect(etatDemandeSecretariat({ statut: "NEW" })).toBe("A_PRENDRE");
    expect(etatDemandeSecretariat({ statut: "IN_PROGRESS" })).toBe("EN_COURS");
    expect(etatDemandeSecretariat({ statut: "AWAITING_VALIDATION" })).toBe("EN_VALIDATION");
    expect(etatDemandeSecretariat({ statut: "AWAITING_PAYMENT" })).toBe("EN_PAIEMENT");
    expect(etatDemandeSecretariat({ statut: "BLOCKED" })).toBe("CHEZ_LE_DEMANDEUR");
    expect(etatDemandeSecretariat({ statut: "DONE" })).toBe("TERMINEE");
    expect(etatDemandeSecretariat({ statut: "CANCELLED" })).toBe("ANNULEE");
  });
  it("en cours : le BC en route la met « en validation », le BC à revoir ou les devis à retenir « chez le demandeur »", () => {
    for (const bc of ["A_VALIDER", "SANS_PORTE", "A_SIGNER"] as const) expect(etatDemandeSecretariat({ statut: "IN_PROGRESS", bc }), bc).toBe("EN_VALIDATION");
    for (const bc of ["A_REVOIR", "A_CORRIGER"] as const) expect(etatDemandeSecretariat({ statut: "IN_PROGRESS", bc }), bc).toBe("CHEZ_LE_DEMANDEUR");
    expect(etatDemandeSecretariat({ statut: "IN_PROGRESS", devisARetenir: true })).toBe("CHEZ_LE_DEMANDEUR");
    // Le BC ne déplace pas une demande déjà close ou en paiement.
    expect(etatDemandeSecretariat({ statut: "DONE", bc: "A_SIGNER" })).toBe("TERMINEE");
    expect(etatDemandeSecretariat({ statut: "AWAITING_PAYMENT", devisARetenir: true })).toBe("EN_PAIEMENT");
  });
});

describe("etat-unifie — les fiches billet / hôtel", () => {
  it("chaque état de la fiche a son état", () => {
    expect(etatFicheVoyage("ENVOYEE")).toBe("A_PRENDRE");
    expect(etatFicheVoyage("PRISE")).toBe("EN_COURS");
    expect(etatFicheVoyage("DEVIS_RECU")).toBe("EN_COURS");
    expect(etatFicheVoyage("MANQUE_SIGNALE")).toBe("CHEZ_LE_DEMANDEUR");
    expect(etatFicheVoyage("MODIFIEE_APRES_ENVOI")).toBe("CHEZ_LE_DEMANDEUR");
    expect(etatFicheVoyage("RESERVEE")).toBe("TERMINEE");
    expect(etatFicheVoyage("RETIREE")).toBe("ANNULEE");
  });
});

describe("etat-unifie — la prospection d'agences", () => {
  it("TOUTES les étapes de la file ont un état — la liste des étapes est celle du module", () => {
    const attendu: Record<string, string> = {
      DEVIS_A_DEPOSER: "EN_COURS", CHOIX: "CHEZ_LE_DEMANDEUR", BC_A_PREPARER: "CHEZ_LE_DEMANDEUR", BC_A_FINALISER: "EN_COURS",
      BC_SOUMIS: "EN_VALIDATION", BC_CHEZ_DG: "EN_VALIDATION", BC_CHEZ_FINANCES: "EN_VALIDATION", BC_A_CORRIGER: "EN_COURS",
      BC_REFUSE_DG: "CHEZ_LE_DEMANDEUR", EXECUTION: "CHEZ_LE_DEMANDEUR", CONFORMITE: "EN_VALIDATION", RECEPTION_FAITE: "TERMINEE", REFUSE: "ANNULEE",
    };
    expect(Object.keys(LIBELLE_ETAPE_FILE).sort()).toEqual(Object.keys(attendu).sort());
    for (const [etape, etat] of Object.entries(attendu)) expect(etatPosteAgence(etape), etape).toBe(etat);
  });
  it("seules les étapes de l'assistante entrent au bureau ; la prospection et le BC ont chacun leur type", () => {
    expect([...ETAPES_AGENCE_AU_BUREAU]).toEqual(["DEVIS_A_DEPOSER", "BC_A_FINALISER", "BC_A_CORRIGER"]);
    expect(typeLigneAgence("DEVIS_A_DEPOSER")).toBe("Prospection d'agence");
    expect(typeLigneAgence("BC_A_FINALISER")).toBe("Bon de commande");
    expect(typeLigneAgence("BC_A_CORRIGER")).toBe("Bon de commande");
  });
});

describe("etat-unifie — BC de poste, matériel promotionnel, devis de prise en charge", () => {
  it("la demande de pièce", () => {
    expect(etatDemandeDePiece("PENDING")).toBe("A_PRENDRE");
    expect(etatDemandeDePiece("DECLINED")).toBe("EN_COURS");
    expect(etatDemandeDePiece("SUBMITTED")).toBe("CHEZ_LE_DEMANDEUR");
    expect(etatDemandeDePiece("ACCEPTED")).toBe("TERMINEE");
    expect(etatDemandeDePiece("CANCELLED")).toBe("ANNULEE");
  });
  it("le matériel promotionnel et les devis de prise en charge", () => {
    expect(etatMaterielPromo("QUOTE_REQUESTED")).toBe("A_PRENDRE");
    expect(etatMaterielPromo("REVIEW_MANAGER")).toBe("EN_COURS");
    expect(etatDevisPriseEnCharge(3)).toBe("A_PRENDRE");
    expect(etatDevisPriseEnCharge(0)).toBe("TERMINEE");
  });
  it("un statut inconnu se lit « En cours » : la ligne ne disparaît pas", () => {
    for (const f of [etatFicheVoyage, etatPosteAgence, etatDemandeDePiece]) expect(f("STATUT_FUTUR")).toBe("EN_COURS");
    expect(etatDemandeSecretariat({ statut: "STATUT_FUTUR" })).toBe("EN_COURS");
    expect(ETATS_BUREAU).toContain("EN_COURS");
  });
});
