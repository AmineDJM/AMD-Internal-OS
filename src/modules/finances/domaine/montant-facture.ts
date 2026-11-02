/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MONTANT DEMANDÉ EST CELUI DE LA FACTURE (Direction, 19/10/2026).
 *
 * Constaté : une demande de paiement déposée depuis « Demandes de validations » portait un montant,
 * sa facture un autre — et rien ne l'avait dit. La cause : le montant de la demande (et donc de son
 * ordre au centre de paiement) était le champ SAISI à la main, rien d'autre. Luna lisait pourtant la
 * facture au dépôt — pour reconnaître un doublon — et son TTC était jeté sans être comparé. Un HT
 * tapé pour un TTC, le chiffre du bon de commande ou du devis, une facture remplacée après coup :
 * tout partait au centre sous le chiffre saisi.
 *
 * La règle : le montant demandé se confronte au TTC LU des factures EN VIGUEUR (une facture
 * remplacée ne compte plus ; plusieurs factures s'additionnent), à un dinar près — la tolérance de
 * toutes les retranscriptions du dépôt. Un écart ne passe plus en silence : il se corrige, ou il
 * s'explique ET se confirme (le geste du poste Ad & Pro, `refusDemandePaiementBC`), et l'explication
 * est écrite dans l'ordre que le centre autorise.
 *
 * Une facture que Luna n'a pas pu lire ne bloque rien (on ne refuse pas un dossier parce que la
 * lecture est indisponible) : le fil dit que le montant n'a pas été vérifié, pièce en main.
 *
 * Module PUR — sans base ni session : le formulaire et l'action lisent la même phrase.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TOLERANCE_MONTANT_FACTURE_DZD = 1;

export type LectureMontant =
  /** Aucune facture en vigueur : rien à confronter (un bon de commande ou un devis seul). */
  | { etat: "SANS_FACTURE" }
  /** Au moins une facture n'a pas de TTC lu : le montant n'est pas vérifiable. */
  | { etat: "NON_LU"; factures: number; lues: number }
  | { etat: "CONFORME"; total: number; factures: number }
  /** `ecart` = montant demandé − total des factures (positif : on demande plus que la facture). */
  | { etat: "ECART"; total: number; factures: number; montant: number; ecart: number };

const centimes = (n: number): number => Math.round(n * 100) / 100;

/** Confronte le montant demandé au TTC lu de chaque facture en vigueur (`null` = non lu). */
export function confronterMontantAuxFactures(montant: number, ttcFactures: readonly (number | null)[]): LectureMontant {
  if (ttcFactures.length === 0) return { etat: "SANS_FACTURE" };
  const lues = ttcFactures.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0);
  if (lues.length < ttcFactures.length) return { etat: "NON_LU", factures: ttcFactures.length, lues: lues.length };
  const total = centimes(lues.reduce((s, t) => s + t, 0));
  const ecart = centimes(montant - total);
  if (Math.abs(ecart) <= TOLERANCE_MONTANT_FACTURE_DZD) return { etat: "CONFORME", total, factures: lues.length };
  return { etat: "ECART", total, factures: lues.length, montant: centimes(montant), ecart };
}

const dzd = (n: number): string => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} DZD`;

/** LA PHRASE de l'écart — déterministe : le fil la garde, et une seconde transmission la reconnaît. */
export function phraseEcartMontant(l: Extract<LectureMontant, { etat: "ECART" }>): string {
  const sur = l.factures > 1 ? `les ${l.factures} factures font ${dzd(l.total)} TTC au total` : `la facture fait ${dzd(l.total)} TTC`;
  return `Montant demandé ${dzd(l.montant)}, ${sur} (écart de ${dzd(Math.abs(l.ecart))}${l.ecart > 0 ? " en plus" : " en moins"}).`;
}

export const PHRASE_MONTANT_NON_LU =
  "Le montant n'a pas pu être confronté à la facture (lecture impossible) : à vérifier pièce en main.";

export const LIBELLE_CONFIRMATION_ECART = "Oui, je confirme ce montant malgré l'écart avec la facture";

/**
 * CE QUI RETIENT LA DEMANDE — `null` : elle peut partir. Un écart exige l'explication ET la case ;
 * un écart DÉJÀ assumé à l'identique (même montant, mêmes factures — la même phrase) ne se redemande pas.
 */
export function refusEcartMontant(a: {
  lecture: LectureMontant;
  justification: string | null;
  confirme: boolean;
  dejaAssume?: boolean;
}): string | null {
  if (a.lecture.etat !== "ECART" || a.dejaAssume) return null;
  const phrase = phraseEcartMontant(a.lecture);
  if (!a.justification?.trim()) {
    return `${phrase} Le montant à payer est celui de la facture (TTC, net à payer) : corrigez-le, ou expliquez l'écart (acompte, avoir, frais hors facture…).`;
  }
  if (!a.confirme) return `${phrase} Cochez « ${LIBELLE_CONFIRMATION_ECART} » pour la faire partir.`;
  return null;
}

/** Ce que l'ordre de dépense et le fil gardent d'un écart assumé — le centre le lit avant d'autoriser. */
export function noteEcartAssume(l: Extract<LectureMontant, { etat: "ECART" }>, justification: string): string {
  return `ÉCART ASSUMÉ par le demandeur : ${phraseEcartMontant(l)} Justification : « ${justification.trim()} ».`;
}
