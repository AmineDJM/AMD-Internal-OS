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
