/**
 * LA NATURE DE L'ÉCHÉANCE — ce qu'une date de paiement PÈSE.
 *
 * ── LE PROBLÈME ──────────────────────────────────────────────────────────────────────────────
 *
 * Une demande de paiement porte une date. Deux dates identiques ne disent pourtant pas la même
 * chose : le 15 d'un fournisseur qui facture au mois n'est pas le 15 d'une quittance dont le
 * retard coûte une pénalité, ni celui d'une échéance simplement « préférable ». La file des
 * Finances traitait les deux à l'identique — la seule information disponible était la date — et
 * l'arbitrage se faisait donc dans la tête de la personne qui savait, quand elle était là.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Le DEMANDEUR qualifie son échéance, parce que c'est lui qui a négocié :
 *
 *   • `FIXED`     — fixe, non négociable : la date est un engagement pris, la déplacer a un coût ;
 *   • `IMPORTANT` — importante : la tenir compte, mais un décalage se discute ;
 *   • `MODERATE`  — moyenne : la date est un repère (valeur par défaut).
 *
 * ── CE QUE ÇA CHANGE, SINON LE CHAMP N'EST QU'UN DÉCOR ───────────────────────────────────────
 *
 * Une qualification qu'on affiche seulement finit ignorée. Elle a donc DEUX conséquences codées :
 *
 *   1. elle **classe la file** — à échéance égale, le fixe non négociable passe devant ;
 *   2. elle **ferme le report muet** — reporter un paiement dont l'échéance est fixe exige de
 *      dire pourquoi. Ce n'est pas un veto : les Finances peuvent parfaitement devoir décaler,
 *      et personne ne peut le leur interdire depuis un formulaire. C'est une TRACE, celle que le
 *      demandeur relira quand il devra expliquer le retard à son fournisseur.
 *
 * Module PUR — aucune dépendance, testé sans base.
 */

export type DeadlineNature = "FIXED" | "IMPORTANT" | "MODERATE";

const NATURES: readonly DeadlineNature[] = ["FIXED", "IMPORTANT", "MODERATE"];

/** Ce qu'on lit à l'écran. Le libellé DIT la conséquence, il ne se contente pas de nommer. */
export const DEADLINE_NATURE_LABEL: Record<DeadlineNature, string> = {
  FIXED: "Fixe, non négociable",
  IMPORTANT: "Importante",
  MODERATE: "Moyenne",
};

/** Plus le rang est bas, plus l'échéance pèse. */
const RANK: Record<DeadlineNature, number> = { FIXED: 0, IMPORTANT: 1, MODERATE: 2 };

/**
 * Lit une valeur venue d'un formulaire ou d'une colonne. Tout ce qui n'est pas reconnu retombe
 * sur `MODERATE` : une nature inventée ne doit jamais faire passer une demande devant les autres.
 */
export function deadlineNatureOf(raw: string | null | undefined): DeadlineNature {
  return NATURES.includes(raw as DeadlineNature) ? (raw as DeadlineNature) : "MODERATE";
}

export function deadlineNatureRank(raw: string | null | undefined): number {
  return RANK[deadlineNatureOf(raw)];
}

export function deadlineNatureLabel(raw: string | null | undefined): string {
  return DEADLINE_NATURE_LABEL[deadlineNatureOf(raw)];
}

/** Une échéance fixe non négociable ne se reporte pas sans un mot. */
export function deferralNeedsReason(raw: string | null | undefined): boolean {
  return deadlineNatureOf(raw) === "FIXED";
}

/**
 * CE QUE L'ÉCRAN DIT AVANT DE REPORTER — ou `null` quand il n'y a rien à dire.
 *
 * On avertit sur `FIXED` et `IMPORTANT`, et pas sur `MODERATE` : un avertissement systématique
 * cesse d'être lu, et c'est exactement le cas où il faudrait qu'il le soit.
 */
export function deferralWarning(raw: string | null | undefined): string | null {
  const nature = deadlineNatureOf(raw);
  if (nature === "FIXED") {
    return "Le demandeur a déclaré cette échéance FIXE et non négociable : elle a été engagée auprès du bénéficiaire. Dites pourquoi elle est reportée — c'est ce qu'il devra expliquer.";
  }
  if (nature === "IMPORTANT") {
    return "Le demandeur a déclaré cette échéance importante : le report se discute, il ne se subit pas.";
  }
  return null;
}

/** Les options d'un `<select>`, dans l'ordre où on les lit : du plus lourd au plus souple. */
export const DEADLINE_NATURE_OPTIONS: { value: DeadlineNature; label: string }[] =
  ["MODERATE", "IMPORTANT", "FIXED"].map((v) => ({ value: v as DeadlineNature, label: DEADLINE_NATURE_LABEL[v as DeadlineNature] }));
