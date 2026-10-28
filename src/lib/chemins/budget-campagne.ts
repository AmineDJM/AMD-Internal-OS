/**
 * OÙ MÈNE UNE NOTIFICATION DE LA CAMPAGNE BUDGÉTAIRE — écrit une fois.
 *
 * Module PUR — aucune importation.
 */

export const CHEMIN_CAMPAGNE_BUDGETAIRE = "/budget-campagne";

/** La proposition d'un pôle, ouverte sur sa préparation (vue du pôle). */
export function lienPropositionPole(proposalId: string): string {
  return `${CHEMIN_CAMPAGNE_BUDGETAIRE}?pole=${encodeURIComponent(proposalId)}`;
}

/** La proposition ouverte dans le panneau d'examen (vue de la Direction), ligne par ligne. */
export function lienExamenProposition(proposalId: string): string {
  return `${CHEMIN_CAMPAGNE_BUDGETAIRE}?examen=${encodeURIComponent(proposalId)}`;
}
