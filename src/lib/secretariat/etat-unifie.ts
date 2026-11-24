import type { EtatBureau } from "./ligne-bureau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN SEUL VOCABULAIRE D'ÉTAT POUR LE BUREAU (Super Admin, 24/11/2026) — chaque famille garde ses statuts
 * en base ; ce module les TRADUIT, une fois, vers `EtatBureau`. Le tableau n'en connaît pas d'autre.
 *
 * Module PUR (aucun import de valeur) : la requête du bureau, les bancs et l'écran lisent la même table.
 * Chaque traduction est TOTALE : un statut inconnu (valeur ajoutée plus tard) se lit « En cours » —
 * une ligne qui attend quelque chose — plutôt que de disparaître du tableau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────── Les demandes du secrétariat ───────────────────────────

/** L'étape du bon de commande d'une demande, telle que `faitsDesDemandes` la lit (`chezQuiDeLaDemande`). */
export type EtapeBcDemande = "A_VALIDER" | "SANS_PORTE" | "A_SIGNER" | "A_REVOIR" | "A_CORRIGER" | null | undefined;

/**
 * UNE DEMANDE DU SECRÉTARIAT. `statut` est le statut AFFICHÉ (`statutAffiche` : une étape retirée se lit
 * « En cours »). Une demande en cours dont le BC attend le centre ou sa signature est « En validation » ;
 * dont le BC ou les devis attendent le demandeur, « Chez le demandeur » — la même lecture que « chez qui ».
 */
export function etatDemandeSecretariat(e: { statut: string; bc?: EtapeBcDemande; devisARetenir?: boolean }): EtatBureau {
  switch (e.statut) {
    case "NEW": return "A_PRENDRE";
    case "AWAITING_VALIDATION": return "EN_VALIDATION";
    case "AWAITING_PAYMENT": return "EN_PAIEMENT";
    case "BLOCKED": return "CHEZ_LE_DEMANDEUR";
    case "DONE": return "TERMINEE";
    case "CANCELLED": return "ANNULEE";
    default: break;
  }
  if (e.bc === "A_VALIDER" || e.bc === "SANS_PORTE" || e.bc === "A_SIGNER") return "EN_VALIDATION";
  if (e.bc === "A_REVOIR" || e.bc === "A_CORRIGER" || e.devisARetenir) return "CHEZ_LE_DEMANDEUR";
  return "EN_COURS";
}

// ─────────────────────────── Les fiches billet / hôtel ───────────────────────────

/**
 * UNE FICHE DE VOYAGE (`DemandeReservation.etat`, lu par `etatLu` : une fiche modifiée après l'envoi le dit).
 * Envoyée : à prendre ; prise ou devis reçu : en cours chez l'assistante ; manque signalé ou modifiée après
 * l'envoi : le demandeur doit la reprendre ; réservée : terminée ; retirée par le demandeur : annulée.
 */
export function etatFicheVoyage(etat: string): EtatBureau {
  switch (etat) {
    case "ENVOYEE": return "A_PRENDRE";
    case "PRISE":
    case "DEVIS_RECU": return "EN_COURS";
    case "MANQUE_SIGNALE":
    case "MODIFIEE_APRES_ENVOI": return "CHEZ_LE_DEMANDEUR";
    case "RESERVEE": return "TERMINEE";
    case "RETIREE": return "ANNULEE";
    default: return "EN_COURS";
  }
}

// ─────────────────────────── La prospection d'agences ───────────────────────────

/** Les étapes de la file du parcours agence (`etapeDeLaFile`) — reprises en chaînes, ce module n'importe rien. */
export type EtapeFileAgence =
  | "DEVIS_A_DEPOSER" | "CHOIX" | "BC_A_PREPARER" | "BC_A_FINALISER" | "BC_SOUMIS" | "BC_CHEZ_DG" | "BC_CHEZ_FINANCES" | "BC_A_CORRIGER"
  | "BC_REFUSE_DG" | "EXECUTION" | "CONFORMITE" | "RECEPTION_FAITE" | "REFUSE";

/** Les étapes où le poste attend L'ASSISTANTE — les seules qui entrent au bureau. */
export const ETAPES_AGENCE_AU_BUREAU: readonly EtapeFileAgence[] = ["DEVIS_A_DEPOSER", "BC_A_FINALISER", "BC_A_CORRIGER"];

/** Le type affiché d'une ligne agence : la prospection (devis), ou le bon de commande à finaliser / corriger. */
export function typeLigneAgence(etape: EtapeFileAgence): "Prospection d'agence" | "Bon de commande" {
  return etape === "DEVIS_A_DEPOSER" ? "Prospection d'agence" : "Bon de commande";
}

/**
 * UN POSTE PAYÉ PAR UNE AGENCE, à son étape de file. Ce que l'assistante fait (devis, BC à finaliser ou à corriger) :
 * en cours ; ce que la Direction Marketing tient (choix, préparation, exécution, BC refusé par le DG) : chez le
 * demandeur ; le centre, le DG, les Finances, l'information médicale : en validation ; réceptionné : terminé.
 */
export function etatPosteAgence(etape: EtapeFileAgence | string): EtatBureau {
  switch (etape) {
    case "DEVIS_A_DEPOSER":
    case "BC_A_FINALISER":
    case "BC_A_CORRIGER": return "EN_COURS";
    case "CHOIX":
    case "BC_A_PREPARER":
    case "BC_REFUSE_DG":
    case "EXECUTION": return "CHEZ_LE_DEMANDEUR";
    case "BC_SOUMIS":
    case "BC_CHEZ_DG":
    case "BC_CHEZ_FINANCES":
    case "CONFORMITE": return "EN_VALIDATION";
    case "RECEPTION_FAITE": return "TERMINEE";
    case "REFUSE": return "ANNULEE";
    default: return "EN_COURS";
  }
}

// ─────────────────────────── Le BC d'un poste (demande de pièce) ───────────────────────────

/**
 * LA DEMANDE DE BC D'UN POSTE (`DocumentRequest`, kind `PURCHASE_ORDER`). À établir : à prendre ; refusée par le
 * demandeur : à redéposer (en cours) ; déposée : le demandeur la vérifie ; acceptée : terminée ; annulée.
 */
export function etatDemandeDePiece(status: string): EtatBureau {
  switch (status) {
    case "PENDING": return "A_PRENDRE";
    case "DECLINED": return "EN_COURS";
    case "SUBMITTED": return "CHEZ_LE_DEMANDEUR";
    case "ACCEPTED": return "TERMINEE";
    case "CANCELLED": return "ANNULEE";
    default: return "EN_COURS";
  }
}

// ─────────────────────────── Matériel promotionnel, devis de prise en charge ───────────────────────────

/** UN DOSSIER DE MATÉRIEL PROMOTIONNEL à son tour : devis demandés (à retranscrire) — à prendre ; sinon en cours. */
export function etatMaterielPromo(circuitState: string): EtatBureau {
  return circuitState === "QUOTE_REQUESTED" ? "A_PRENDRE" : "EN_COURS";
}

/** LES DEVIS D'UNE PRISE EN CHARGE : des éléments encore à chiffrer — à prendre ; aucun : terminé. */
export function etatDevisPriseEnCharge(elementsAChiffrer: number): EtatBureau {
  return elementsAChiffrer > 0 ? "A_PRENDRE" : "TERMINEE";
}
