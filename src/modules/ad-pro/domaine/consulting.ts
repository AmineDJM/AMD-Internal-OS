/**
 * LE CYCLE DE VIE D'UN CONTRAT DE CONSULTING.
 *
 * Un contrat n'est pas une demande qu'on approuve puis qu'on oublie : c'est une relation qui
 * court dans le temps. Elle se prépare (brouillon), se fait valider, s'exécute (actif), puis
 * s'achève — soit parce qu'elle est arrivée à son terme (expiré), soit parce qu'on l'a rompue
 * (annulé). Les deux fins ne se confondent pas : la première a produit ses effets jusqu'au bout,
 * la seconde non, et l'on ne travaille pas de la même façon avec un prestataire selon le cas.
 *
 * Les transitions vivent ici plutôt que dans les actions serveur pour une raison précise :
 * « peut-on annuler un contrat déjà expiré ? » est une question de RÈGLE, pas de formulaire. Une
 * règle dispersée dans cinq boutons finit par se contredire d'un bouton à l'autre.
 *
 * Module PUR — testé.
 */

export type ConsultingState = "DRAFT" | "AWAITING_VALIDATION" | "ACTIVE" | "EXPIRED" | "CANCELLED";

export type ConsultingMove =
  /** Le porteur envoie son contrat à la validation. */
  | "SUBMIT"
  /** Le validateur accepte : le contrat entre en vigueur. */
  | "APPROVE"
  /** Le validateur refuse : la relation ne commence pas. */
  | "REFUSE"
  /**
   * Le validateur RENVOIE pour correction (audit 360°, lot C4a) : le contrat revient en brouillon chez
   * son porteur, qui le corrige et le resoumet. Sans ce geste, un contrat mal saisi n'avait qu'une
   * issue — le refus, c'est-à-dire l'annulation pour toujours.
   */
  | "RETURN"
  /** Le terme est atteint. */
  | "EXPIRE"
  /** On rompt en cours de route. */
  | "CANCEL";

/**
 * Ce qu'un contrat peut devenir, depuis où il en est. `null` = le geste n'a pas de sens ici, et
 * c'est un refus explicite plutôt qu'un silence : l'écran doit pouvoir le dire.
 */
const MOVES: Record<ConsultingState, Partial<Record<ConsultingMove, ConsultingState>>> = {
  DRAFT: { SUBMIT: "AWAITING_VALIDATION", CANCEL: "CANCELLED" },
  // Un contrat en attente peut encore être retiré par son porteur — mais pas « expirer » :
  // rien n'a commencé.
  AWAITING_VALIDATION: { APPROVE: "ACTIVE", REFUSE: "CANCELLED", RETURN: "DRAFT", CANCEL: "CANCELLED" },
  ACTIVE: { EXPIRE: "EXPIRED", CANCEL: "CANCELLED" },
  // Une fin est une fin. Rouvrir un contrat clos effacerait la date à laquelle il s'est terminé —
  // celle qu'on cherche justement quand on se demande jusqu'à quand on a travaillé ensemble.
  EXPIRED: {},
  CANCELLED: {},
};

export function nextConsultingStatus(from: string, move: ConsultingMove): ConsultingState | null {
  const table = MOVES[from as ConsultingState];
  return table ? table[move] ?? null : null;
}

/** Un contrat clos ne se modifie plus : ses termes font foi tels qu'ils étaient. */
export function isContractEditable(status: string): boolean {
  return status === "DRAFT" || status === "AWAITING_VALIDATION" || status === "ACTIVE";
}

/** Les contrats qui attendent une décision — ce que le validateur doit voir en premier. */
export function isAwaitingDecision(status: string): boolean {
  return status === "AWAITING_VALIDATION";
}

/**
 * Un contrat ACTIF dont le terme est passé.
 *
 * On ne bascule pas le statut tout seul en base : une échéance dépassée d'un jour se prolonge
 * souvent d'un avenant, et un logiciel qui clôt de lui-même la relation oblige à la rouvrir. On
 * le SIGNALE, et quelqu'un tranche.
 */
export function isOverdue(contract: { status: string; endDate: Date | string | null }, now: Date = new Date()): boolean {
  if (contract.status !== "ACTIVE" || !contract.endDate) return false;
  const end = contract.endDate instanceof Date ? contract.endDate : new Date(contract.endDate);
  return !Number.isNaN(end.getTime()) && end < now;
}

/**
 * Le montant écrit avec son rythme — « 200 000 DZD / mois », pas « 200 000 DZD ».
 *
 * Un forfait unique et un mensuel du même chiffre n'engagent pas la même somme, et c'est
 * exactement la confusion qui coûte cher au moment de la facture.
 */
export function billingSuffix(billing: string): string {
  switch (billing) {
    case "MONTHLY": return " / mois";
    case "QUARTERLY": return " / trimestre";
    case "YEARLY": return " / an";
    case "ON_DELIVERY": return " à la livraison";
    default: return "";
  }
}

/**
 * L'engagement TOTAL d'un contrat périodique, pour le comparer aux autres dépenses.
 *
 * Sans terme connu, on ne devine pas : on rend `null` plutôt qu'un chiffre inventé qu'on
 * retrouverait ensuite dans un tableau de budget.
 */
export function totalCommitment(c: { amount: number | null; billing: string; startDate: Date | string | null; endDate: Date | string | null }): number | null {
  if (c.amount == null) return null;
  if (c.billing === "ONE_OFF" || c.billing === "ON_DELIVERY") return c.amount;
  if (!c.startDate || !c.endDate) return null;
  const start = c.startDate instanceof Date ? c.startDate : new Date(c.startDate);
  const end = c.endDate instanceof Date ? c.endDate : new Date(c.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  const months = Math.max(1, Math.round((end.getTime() - start.getTime()) / (30.44 * 24 * 3600 * 1000)));
  const periods = c.billing === "MONTHLY" ? months : c.billing === "QUARTERLY" ? months / 3 : months / 12;
  return Math.round(c.amount * Math.max(1, periods) * 100) / 100;
}
