import type { Annulation } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ANNULATIONS DÉCLARÉES (K10c, décision 0036) — pur, zéro import hors du dossier.
 *
 * La dérivation lexicale (`classement.ts`) classe une action par ses mots : « régler » y vaut paiement, une décision
 * y vaut signature. Pour les actions qu'un lot a RENDUES réversibles — le geste inverse codé (`lib/effets/`), un test
 * qui exécute puis annule contre la base —, la fiche dit comment elle se défait vraiment. Une entrée ici sans
 * l'annulation codée et testée est un mensonge : `reversibles-metiers.test.ts` (le cliquet du périmètre) le refuse.
 *
 *   • « retour »       — l'état d'avant revient (statut remis, valeurs d'avant réécrites, création retirée, corbeille).
 *   • « compensation » — un geste inverse tracé : ordre de paiement passé à ANNULÉ, rectificatif à qui avait lu,
 *                        envoi différé retiré dans sa fenêtre ou compensé après.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface AnnulationDeclaree { annulation: Exclude<Annulation, "aucune">; raison: string }

const retour = (raison: string): AnnulationDeclaree => ({ annulation: "retour", raison });
const compensation = (raison: string): AnnulationDeclaree => ({ annulation: "compensation", raison });

const REGLAGE = "un réglage : l'annulation remet la valeur d'avant (journal des effets), si personne ne l'a changée depuis";
const ORDRE = "l'ordre de paiement, sa pièce et le dossier compagnon sont retirés (ou passés à ANNULÉ s'ils ont bougé) ; refusée, avec la liste, si l'ordre est payé";
const FICHE = "la fiche revient à son état d'avant ; la notification à l'assistante est retirée si elle n'a pas été lue, rectifiée sinon";

/** K10c — Ad & Pro, congrès, RH, juridique, promo, réservations, validations, réglages de l'Assistant IA. */
export const ANNULATIONS_DECLAREES: Readonly<Record<string, AnnulationDeclaree>> = {
  "ad-pro-item-actions:annulerOrdrePoste": retour("l'ordre, la facture et le poste reprennent leur statut d'avant ; refusée si l'ordre a été réémis depuis"),
  "ad-pro-item-actions:deleteAdProItem": retour("le poste revient de la corbeille avec ses éléments liés (même identifiant), l'ordre reprend son statut"),
  "ad-pro-item-actions:demanderPaiementPoste": compensation(ORDRE),
  "assistant-ia-actions:reglerMaReponseVocale": retour(REGLAGE),
  "assistant-ia-conversations-actions:reglerMaConversationPrivee": retour(REGLAGE),
  "assistant-ia-proactivite-actions:reglerConsoleProactivite": retour(REGLAGE),
  "assistant-ia-proactivite-actions:reglerMaVeille": retour(REGLAGE),
  "assistant-ia-proactivite-actions:reglerMonVeilleur": retour(`${REGLAGE} ; les constats écartés par l'arrêt reviennent en attente`),
  "assistant-ia-travaux-actions:reglerMaPreferenceDOffice": retour(REGLAGE),
  "assistant-ia-travaux-actions:reglerPrioriteMonTravail": retour(REGLAGE),
  "budget-pole-actions:imputerBv": retour("l'ordre (ou l'écriture payée) retrouve sa catégorie budgétaire d'avant"),
  "congress-request-actions:finalDecision": compensation("l'étape de décision est rouverte ; l'ordre de paiement et la déclaration nés de l'accord sont retirés ou annulés ; le demandeur reçoit un rectificatif s'il avait lu"),
  "congress-request-actions:updateGrantedBudget": retour("le montant accordé, celui de la déclaration et celui de l'ordre non réglé reviennent"),
  "hr-actions:cancelAdvance": retour("l'avance revient en attente ; la notification est retirée ou rectifiée"),
  "hr-actions:decideAdvance": compensation(`l'avance revient en attente de décision ; ${ORDRE}`),
  "hr-actions:requestAdvance": retour("la demande d'avance est retirée (ou passée à ANNULÉE si elle a bougé)"),
  "legal-actions:cancelLegalDocument": retour("la pièce, son ordre non réglé et les visas du BC reprennent leur statut d'avant"),
  "legal-actions:createLegalDocument": compensation("la pièce créée est retirée si rien ne s'y est rattaché, passée à ANNULÉE sinon ; ses visas et l'écriture de règlement suivent"),
  "legal-actions:sendLegalInvoiceToSettlement": compensation(ORDRE),
  "legal-actions:updateLegalDocument": retour("les champs de la pièce reprennent leur valeur d'avant (une signature tombée revient avec eux)"),
  "lieux-actions:reglerDoubleEcritureLieux": retour(REGLAGE),
  "natures-moyens-generaux-actions:classerDepensesNonClassees": retour("chaque dépense reclassée retrouve sa catégorie d'avant ; les natures créées sont retirées si rien ne s'y rattache"),
  "notification-actions:sendBroadcast": compensation("la diffusion attend sa fenêtre d'annulation : annulée dedans, rien n'est parti ; après, les notifications non lues sont retirées et un rectificatif va à qui l'a lue — la poussée affichée ne se reprend pas"),
  "onlyoffice-diagnostic-actions:testerEditeurOffice": retour("un diagnostic en lecture : il n'écrit rien, il n'y a rien à défaire"),
  "organisation-actions:reglerDoubleEcritureOrganisations": retour(REGLAGE),
  "process-intelligence-actions:reglerDelaiEtape": retour(`${REGLAGE} ; un délai retiré est recréé à l'identique`),
  "promo-budget-actions:imputerBudgetMaterielPromo": retour("le dossier, ses ordres et leurs écritures retrouvent leur catégorie d'avant"),
  "promo-execution-actions:annulerFacturePromo": retour("la facture et son ordre non réglé reprennent leur statut d'avant"),
  "promo-execution-actions:demanderPaiementFacturePromo": compensation(`${ORDRE} ; la déclaration à l'information médicale suit, les lignes abandonnées reviennent`),
  "promo-material-actions:cancelPromoMaterial": retour("le dossier, ses demandes au secrétariat, leurs validations et leurs ordres reprennent leur statut d'avant"),
  "promo-material-actions:initiatePayment": compensation(`le dossier revient au BC envoyé ; ${ORDRE}`),
  "promo-material-actions:settle": compensation(`le dossier revient à « facturé » (ou l'ordre de règlement est retiré) ; ${ORDRE}`),
  "regulatory-actions:requestBV": compensation(`${ORDRE} ; l'étape du processus revient ; la pièce déposée suit sa ligne`),
  "relance-paiement-actions:relancerPaiement": compensation("la relance est retirée du fil ; les notifications non lues sont retirées, un rectificatif va à qui l'a lue — la poussée ne se reprend pas"),
  "reservation-fiche-actions:deposerBillet": compensation("la fiche revient à son état d'avant la réservation ; les billets déposés sont retirés ; la notification est retirée ou rectifiée"),
  "reservation-fiche-actions:envoyerFiche": compensation(FICHE),
  "reservation-fiche-actions:envoyerFichesPretes": compensation(FICHE),
  "reservation-fiche-actions:joindreDevisAgence": compensation("le devis et sa demande de pièce sont retirés (ou annulés s'ils ont bougé) ; la fiche revient à son état d'avant"),
  "reservation-fiche-actions:prendreFiche": retour(FICHE),
  "reservation-fiche-actions:relancerFiche": retour(FICHE),
  "reservation-fiche-actions:retirerFiche": retour(FICHE),
  "reservation-fiche-actions:signalerManque": retour(FICHE),
  "validation-actions:decideValidation": compensation("l'étape est rouverte (décision effacée, demande en attente) ; l'ordre né de l'accord est retiré ou annulé ; refusée, avec la liste, si l'ordre est payé ; rectificatif à qui avait lu"),
};
