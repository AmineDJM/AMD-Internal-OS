/**
 * OÙ MÈNE UNE NOTIFICATION DES FINANCES — écrit une fois.
 *
 * Module PUR — aucune importation.
 */

export const CHEMIN_PAIEMENTS_A_FAIRE = "/finances/paiements-a-faire";

export const CHEMIN_CENTRE_DE_PAIEMENT = "/centre-de-paiement";

/**
 * LE CENTRE DE PAIEMENT ouvert sur l'ENTITÉ où le paiement attend — sans elle, il s'ouvre sur
 * l'entité qui attend le plus, souvent pas celle de la notification. Une seule file par entité :
 * plus de section dans l'adresse (les anciens `?section=` sont ignorés par l'écran).
 */
export function lienCentreDePaiement(entite?: string | null): string {
  return entite ? `${CHEMIN_CENTRE_DE_PAIEMENT}?entite=${encodeURIComponent(entite)}` : CHEMIN_CENTRE_DE_PAIEMENT;
}

/** UN ordre de dépense, sa ligne mise en évidence dans « Paiements à faire » (`?focus=` + ancre). */
export function lienOrdreAPayer(orderId: string | null | undefined): string {
  if (!orderId) return CHEMIN_PAIEMENTS_A_FAIRE;
  const e = encodeURIComponent(orderId);
  return `${CHEMIN_PAIEMENTS_A_FAIRE}?focus=${e}#ord-${e}`;
}
