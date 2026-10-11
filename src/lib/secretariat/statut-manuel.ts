/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLUS AUCUN STATUT NE SE POSE À LA MAIN SUR UNE DEMANDE AU SECRÉTARIAT (Direction, 10/2026).
 *
 * Historique (§118.191 — audit 360°, R12) : un menu « Changer le statut » offrait les neuf statuts,
 * sans condition — « Terminée » contournait la fin gardée, « Annulée » l'annulation commune, une
 * demande annulée se ressuscitait d'un clic. Il était devenu quatre gestes nommés (en attente d'un
 * tiers, d'un document, bloquer, reprendre).
 *
 * La Direction a tranché : l'assistante de direction n'a que DEUX gestes — « Commencer le
 * traitement » et « Fin du traitement » (`secretariat/traitement.ts`). Ces quatre gestes sont
 * retirés ; une demande déjà posée dans l'un d'eux se lit « En cours » et se termine normalement.
 * Restent leurs portes : annuler (avec motif), rouvrir une demande traitée (avec motif).
 *
 * Module PUR — l'action et l'écran lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les statuts qu'un gestionnaire pose à la main : aucun. */
export const STATUTS_MANUELS = [] as const;

export function estStatutManuel(s: string): boolean {
  return (STATUTS_MANUELS as readonly string[]).includes(s);
}

/**
 * Pourquoi ce changement de statut n'est PAS posable à la main — jamais `null` désormais.
 * L'état de la demande d'abord (§118.18), puis la porte qui convient.
 */
export function refusDuStatutManuel(input: { courant: string; cible: string; motif: string | null }): string | null {
  const { courant, cible } = input;
  if (courant === "CANCELLED") return "Cette demande est annulée : elle ne se rouvre pas — déposez-en une nouvelle.";
  if (courant === "DONE") return "Cette demande est traitée : elle se rouvre par « Rouvrir », avec son motif.";
  if (cible === "DONE") return "La fin d'une demande passe par « Fin du traitement » : c'est elle qui vérifie la facture d'un achat et son imputation.";
  if (cible === "CANCELLED") return "Annuler une demande passe par « Annuler la demande », avec son motif : elle retire aussi les validations et les paiements qui en dépendent.";
  return "Le traitement n'a que deux gestes : « Commencer le traitement » et « Fin du traitement ».";
}

/** Pourquoi la demande ne se ROUVRE pas — `null` si elle le peut. */
export function refusDeReouverture(input: { courant: string; motif: string | null }): string | null {
  if (input.courant === "CANCELLED") return "Une demande annulée ne se rouvre pas : ce qui en dépendait a été retiré avec elle. Déposez-en une nouvelle.";
  if (input.courant !== "DONE") return "Seule une demande traitée se rouvre.";
  if (input.motif === null) return "Dites pourquoi vous la rouvrez : c'est ce que lira le demandeur.";
  return null;
}
