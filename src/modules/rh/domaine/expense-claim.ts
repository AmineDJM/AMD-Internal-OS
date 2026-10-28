/**
 * LA NOTE DE FRAIS — son montant, sa pièce, et les quinze minutes pour se corriger.
 *
 * ── POURQUOI LE MONTANT SORT DU TEXTE ───────────────────────────────────────────────────────
 *
 * Il vivait DANS le motif : « 4 200 DZD — taxi et péage, déplacement PCH Alger du 12/09 ». Un
 * montant noyé dans une phrase ne s'additionne pas, ne se compare pas, ne se contrôle pas — les
 * RH relisaient chaque ligne pour savoir ce qu'on leur demandait de rembourser, et un chiffre mal
 * recopié ne se voyait nulle part. Chaque note porte donc SON montant et SA pièce ; deux dépenses
 * distinctes font deux notes, et c'est ce qui permet de les instruire séparément.
 *
 * ── POURQUOI QUINZE MINUTES ─────────────────────────────────────────────────────────────────
 *
 * On envoie, on relit, on voit qu'on s'est trompé d'un chiffre. Sans fenêtre de correction, il
 * faut annuler et refaire : deux demandes dans l'historique, dont une morte, et des RH qui
 * devinent laquelle fait foi. Quinze minutes, c'est le temps de se relire — pas celui de changer
 * d'avis une fois la demande instruite.
 *
 * Passé le délai, la note n'est PAS figée pour toujours : les RH la rouvrent. « Votre reçu est
 * illisible, corrigez » n'a aucun sens si la personne ne peut plus rien changer — elle refait une
 * seconde note, et l'on se retrouve avec deux demandes pour une dépense.
 *
 * ── CE QUI NE S'EFFACE JAMAIS ───────────────────────────────────────────────────────────────
 *
 * Modifier ne recrée rien : c'est la MÊME demande qui change, elle garde son identité, ses
 * pièces et son fil. Elle reste donc à vie dans l'historique de la personne — et chaque
 * modification est portée à l'audit, avec l'ancien et le nouveau montant.
 *
 * Module PUR : la règle se lit et se teste sans base.
 */

/** Le temps de se relire, pas celui de changer d'avis. */
export const EXPENSE_EDIT_MINUTES = 15;

const MS = EXPENSE_EDIT_MINUTES * 60_000;

/** La fin de la fenêtre, POSÉE à l'envoi (et non recalculée à chaque lecture). */
export function expenseEditDeadline(sentAt: Date): Date {
  return new Date(sentAt.getTime() + MS);
}

/** L'état d'une note de frais, du seul point de vue de « peut-on encore la corriger ? ». */
export interface ExpenseEditState {
  /** Fin des quinze minutes. `null` sur les notes antérieures à cette règle. */
  editableUntil: Date | string | null;
  /** Réouverture décidée par les RH — elle prime sur le délai. */
  editUnlockedAt: Date | string | null;
  /** Une note déjà tranchée ne se modifie plus, fenêtre ouverte ou non. */
  status: string;
}

/** Pourquoi c'est ouvert, ou pourquoi ça ne l'est pas — une raison par cas, jamais un booléen nu. */
export type ExpenseEditReason =
  | "WINDOW"      // dans les quinze minutes
  | "UNLOCKED"    // les RH ont rouvert
  | "EXPIRED"     // le délai est passé, personne n'a rouvert
  | "DECIDED";    // la demande est traitée : il n'y a plus rien à corriger

/**
 * LES ÉTATS OÙ IL N'Y A PLUS RIEN À CORRIGER.
 *
 * Laisser modifier une note déjà remise ou refusée changerait, après coup, ce sur quoi quelqu'un
 * s'est prononcé — et l'audit dirait « validée » à côté d'un montant que le validateur n'a
 * jamais vu. Une note refusée se REFAIT ; elle ne se réécrit pas.
 */
const ETATS_TRANCHES: readonly string[] = ["READY", "DELIVERED", "APPROVED", "REJECTED"];

const asDate = (v: Date | string | null): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface ExpenseEditVerdict {
  allowed: boolean;
  reason: ExpenseEditReason;
  /** Minutes restantes dans la fenêtre — 0 hors fenêtre. Arrondi au SUPÉRIEUR : annoncer
   *  « 0 min » alors qu'il reste quarante secondes ferait renoncer à une correction possible. */
  minutesLeft: number;
}

export function canEditExpenseClaim(state: ExpenseEditState, now: Date = new Date()): ExpenseEditVerdict {
  if (ETATS_TRANCHES.includes(state.status)) return { allowed: false, reason: "DECIDED", minutesLeft: 0 };
  // LA RÉOUVERTURE PRIME SUR LE DÉLAI : c'est une décision humaine, prise en connaissance de
  // cause, et elle n'aurait aucun sens si l'horloge pouvait la contredire.
  if (asDate(state.editUnlockedAt)) return { allowed: true, reason: "UNLOCKED", minutesLeft: 0 };
  const fin = asDate(state.editableUntil);
  if (fin && fin.getTime() > now.getTime()) {
    return { allowed: true, reason: "WINDOW", minutesLeft: Math.ceil((fin.getTime() - now.getTime()) / 60_000) };
  }
  return { allowed: false, reason: "EXPIRED", minutesLeft: 0 };
}

/**
 * CE QU'ON ÉCRIT AU DEMANDEUR.
 *
 * Un bouton grisé sans explication se lit comme une panne. Chaque cas dit ce qui se passe ET ce
 * qu'on peut faire ensuite — sans quoi la personne dépose une seconde note, ce que toute cette
 * mécanique existe pour éviter.
 */
export function expenseEditLabel(v: ExpenseEditVerdict): string {
  switch (v.reason) {
    case "WINDOW":
      return v.minutesLeft <= 1
        ? "Modifiable encore une minute."
        : `Modifiable encore ${v.minutesLeft} minutes.`;
    case "UNLOCKED":
      return "Les RH ont rouvert la modification : corrigez, puis renvoyez.";
    case "EXPIRED":
      return `Le délai de ${EXPENSE_EDIT_MINUTES} minutes est écoulé. Demandez aux RH de rouvrir la modification — ne déposez pas une seconde note pour la même dépense.`;
    case "DECIDED":
      return "Cette note est traitée : elle ne se modifie plus. Une note refusée se refait, elle ne se réécrit pas.";
  }
}

/**
 * LE MONTANT EST-IL RECEVABLE ?
 *
 * Zéro n'est pas un montant de note de frais : c'est un champ qu'on a sauté. L'accepter ferait
 * entrer dans la file une demande de remboursement de rien, que quelqu'un devra instruire pour
 * découvrir qu'elle est vide. Le plafond n'est pas une règle de gestion — c'est une barrière
 * contre la faute de frappe : 4 200 tapé 4200000 se rembourse une fois, et se récupère jamais.
 */
export const EXPENSE_AMOUNT_MAX = 10_000_000;

export function expenseAmountError(amount: number | null): string | null {
  if (amount === null) return "Indiquez le montant que vous avez avancé.";
  if (!Number.isFinite(amount) || amount <= 0) return "Le montant doit être supérieur à zéro.";
  if (amount > EXPENSE_AMOUNT_MAX) return "Ce montant paraît erroné. Vérifiez-le, ou déposez plusieurs notes.";
  return null;
}
