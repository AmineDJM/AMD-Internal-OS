import { describe, expect, it } from "vitest";
import {
  etatDemandeDePiece, etatDemandeSecretariat, etatDevisPriseEnCharge, etatFicheVoyage, etatMaterielPromo,
} from "./etat-unifie";
import { ETATS_BUREAU } from "./ligne-bureau";

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
    for (const f of [etatFicheVoyage, etatDemandeDePiece]) expect(f("STATUT_FUTUR")).toBe("EN_COURS");
    expect(etatDemandeSecretariat({ statut: "STATUT_FUTUR" })).toBe("EN_COURS");
    expect(ETATS_BUREAU).toContain("EN_COURS");
  });
});
