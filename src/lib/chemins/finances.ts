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

/** « Informations de la société » (Legal) — la carte d'identité et les locaux & charges fixes d'une société. */
export const CHEMIN_INFORMATIONS_SOCIETE = "/legal/identites";
/** L'ancre de la section « Locaux & charges fixes ». */
export const ANCRE_CHARGES_FIXES = "charges-fixes";

/**
 * UNE ÉCHÉANCE DE CHARGE FIXE à payer (24/11/2026) : la société ouverte, l'échéance désignée (`charge:période`), la
 * section des charges fixes sous les yeux. C'est là que les Finances joignent la facture et demandent le paiement.
 */
export function lienEcheanceChargeFixe(companyId: string, cle?: string | null): string {
  const q = new URLSearchParams({ entite: companyId, ...(cle ? { echeance: cle } : {}) });
  return `${CHEMIN_INFORMATIONS_SOCIETE}?${q.toString()}#${ANCRE_CHARGES_FIXES}`;
}
