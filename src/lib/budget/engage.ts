/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENGAGÉ ET LA DATE D'UNE DÉPENSE — deux corrections de la vue d'ensemble (Direction, 10/2026).
 *
 * 1. « ENGAGÉ » AFFICHAIT 0 alors que des bons de commande étaient émis et non payés. La cause : l'engagé ne lisait que
 *    les écritures de trésorerie `PENDING` imputées — or le circuit n'en écrit jamais. Un ordre de dépense reste
 *    `PENDING` jusqu'au règlement, et l'écriture naît `SETTLED` au paiement ; un BC signé n'écrit rien en trésorerie.
 *    L'engagé se lit donc là où l'argent est promis : les ORDRES DE DÉPENSE non réglés et les BC ÉMIS (non annulés)
 *    des postes accordés, moins ce qui est déjà payé — jamais deux fois le même dinar.
 *
 * 2. LA COURBE SAUTAIT EN JUILLET : une écriture réglée depuis le centre de paiement porte la date du CLIC
 *    (`date: new Date()`), pas celle de la dépense ; des dépenses rattrapées le même mois s'empilaient sur ce mois.
 *    Une dépense se date désormais par ce qui la date vraiment : la date SAISIE de l'écriture quand quelqu'un l'a
 *    écrite, sinon le règlement ou la date de sa facture, et seulement à défaut le jour de la saisie.
 *
 * Module PUR, sans aucun import : testé, lisible côté client comme côté serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Statuts d'un ordre de dépense qui engagent encore de l'argent (émis, pas réglé, pas annulé). */
export const STATUTS_ORDRE_ENGAGES = ["PENDING", "REVISION_REQUESTED"] as const;

/**
 * UN ORDRE ENGAGE-T-IL ENCORE DE L'ARGENT ? Émis, pas réglé, pas annulé — ET PAS REFUSÉ PAR LE CENTRE (audit 27/10,
 * ARGENT-07). Un refus du centre laisse l'ordre `PENDING` (seule son autorisation change) : lu sur le seul statut, un
 * ordre de 300 000 refusé « hors budget » restait engagé sur sa catégorie jusqu'à ce que quelqu'un annule la source,
 * et l'enveloppe paraissait pleine. Un ordre refusé ne paiera jamais (`ordreClos`, `finances/settlement.ts`).
 */
export function ordreEngage(statut: string | null | undefined, centralStatus?: string | null): boolean {
  return statut != null && (STATUTS_ORDRE_ENGAGES as readonly string[]).includes(statut) && centralStatus !== "REFUSED";
}

/** Ce qu'on sait de l'argent d'un poste accordé. */
export interface EngagementPoste {
  /** Total des BC émis (non annulés) du poste. */
  bc: number;
  /** Déjà payé pour ce poste (ordres réglés, factures réglées). */
  paye: number;
  /** Ordres de dépense du poste émis, pas encore réglés. */
  enAttente: number;
}

const positif = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * L'ENGAGÉ D'UN POSTE : ce qui est promis et pas encore payé.
 *  - les ordres en attente comptent en entier (l'argent est demandé) ;
 *  - le BC compte pour ce qu'il reste à payer dessus (BC − payé) ;
 *  - le plus grand des deux, jamais leur somme : l'ordre en attente PAIE le BC, ce n'est pas une seconde dépense.
 */
export function engagementDuPoste(p: EngagementPoste): number {
  return Math.max(positif(p.enAttente), positif(p.bc) - positif(p.paye), 0);
}

/** Ce que le BC ajoute aux ordres en attente du poste (déjà comptés ailleurs) — jamais négatif. */
export function surplusDuBc(p: EngagementPoste): number {
  return Math.max(0, engagementDuPoste(p) - positif(p.enAttente));
}

// ───────────────────────────── La date d'une dépense ─────────────────────────────

export interface DatesDepense {
  /** `FinanceTransaction.date` (ou `BudgetExpenseLine.date`). */
  date: Date;
  /** L'instant où la ligne a été écrite. Absent = on ne sait pas : la date de la ligne fait foi. */
  createdAt?: Date | null;
  /** La date de règlement d'une facture liée (`LegalDocument.paidDate`). */
  facturePayeeLe?: Date | null;
  /** La date de la facture liée (`LegalDocument.startDate` d'une facture). */
  factureDu?: Date | null;
}

/** Écart au-delà duquel la date d'une ligne n'est plus « l'instant de sa saisie » mais une date choisie. */
const SEUIL_SAISIE_MS = 60_000;

/** La date de la ligne a-t-elle été choisie (et non posée d'office à l'instant de la saisie) ? */
export function dateChoisie(date: Date, createdAt: Date | null | undefined): boolean {
  if (!createdAt) return true;
  return Math.abs(date.getTime() - createdAt.getTime()) > SEUIL_SAISIE_MS;
}

const valide = (d: Date | null | undefined): d is Date => d instanceof Date && Number.isFinite(d.getTime());

/**
 * LA DATE DE LA DÉPENSE, dans cet ordre : la date choisie à la saisie ; le règlement de sa facture ; la date de sa
 * facture ; à défaut seulement, le jour où elle a été écrite.
 */
export function dateDeLaDepense(d: DatesDepense): Date {
  if (dateChoisie(d.date, d.createdAt)) return d.date;
  if (valide(d.facturePayeeLe)) return d.facturePayeeLe;
  if (valide(d.factureDu)) return d.factureDu;
  return d.date;
}

/**
 * Ramène une date dans la période lue : une dépense comptée dans la période (par sa date d'écriture) reste dans la
 * courbe même si sa facture date du mois d'avant l'ouverture — sinon la courbe et le compteur divergeraient.
 */
export function dansLaPeriode(d: Date, from: Date, to: Date): Date {
  if (d.getTime() < from.getTime()) return from;
  if (d.getTime() > to.getTime()) return to;
  return d;
}

/** La clé « 2026-03 » d'une date (UTC). */
export function cleMois(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
