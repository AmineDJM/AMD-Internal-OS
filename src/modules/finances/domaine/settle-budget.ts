/**
 * ON CLASSE AVANT DE PAYER — le budget n'est plus une case à cocher après coup.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Au règlement, la dépense cherchait sa catégorie budgétaire : celle que la Direction avait
 * choisie, sinon celle du module d'origine (`pickAutoCategory`). Quand aucune ne répondait, le
 * paiement partait quand même et l'écriture naissait SANS budget. Elle rejoignait alors la pile
 * des « à imputer » — une liste que quelqu'un devait reprendre à la main, et que personne ne
 * reprend jamais. Six mois plus tard, l'enveloppe affiche une consommation fausse, et l'on
 * arbitre l'année suivante sur ce chiffre-là.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────────
 *
 * Si le budget n'est pas défini, **les Finances paient — mais elles classent d'abord**. Le
 * classement n'est pas un veto sur le paiement : c'est un geste de plus dans le même écran,
 * exigé une fois, au moment où quelqu'un a le dossier sous les yeux. Après le virement, plus
 * personne n'a de raison d'y revenir.
 *
 * ── L'EXCEPTION QUI ÉVITE L'IMPASSE ─────────────────────────────────────────────────────────
 *
 * S'il n'existe AUCUNE catégorie budgétaire dans la plateforme, exiger un choix n'est pas une
 * règle : c'est une porte fermée à clé sur une pièce vide. Une installation qui n'a pas encore
 * ouvert ses enveloppes doit pouvoir payer ses factures. La dépense reste alors « à imputer »,
 * et c'est dit — pas rangé en silence dans une enveloppe voisine.
 *
 * Module PUR : ni base, ni session. Testé.
 */

export interface BudgetGateInput {
  /** La catégorie choisie PAR LES FINANCES au moment de régler, si elles en ont choisi une. */
  chosen?: string | null;
  /** Celle posée sur l'ordre par la Direction à la validation. */
  onOrder?: string | null;
  /** Celle que l'attribution automatique déduit du module d'origine (`pickAutoCategory`). */
  auto?: string | null;
  /** Combien de catégories existent où classer. Zéro = la plateforme n'en a aucune. */
  availableCount: number;
}

export interface BudgetGate {
  ok: boolean;
  /** La catégorie retenue — `null` quand la dépense part « à imputer », faute de catalogue. */
  categoryId: string | null;
  reason?: string;
}

/** Le message affiché quand il faut classer avant de payer. */
export const BUDGET_CLASSIFY_PROMPT =
  "Cette dépense n'est rattachée à aucun budget. Classez-la dans sa catégorie exacte avant de la régler — après le virement, plus personne n'y reviendra.";

/**
 * QUELLE CATÉGORIE, ET PEUT-ON PAYER ?
 *
 * L'ordre des trois chances n'est pas arbitraire : **le choix fait au règlement l'emporte**, parce
 * qu'il est le plus récent et le plus informé — c'est quelqu'un qui a la facture sous les yeux.
 * Vient ensuite celui de la Direction, posé à la validation ; puis l'attribution automatique,
 * qui ne fait que deviner d'après le module d'origine.
 */
export function budgetGate(input: BudgetGateInput): BudgetGate {
  const retenue = pick(input.chosen) ?? pick(input.onOrder) ?? pick(input.auto);
  if (retenue) return { ok: true, categoryId: retenue };

  // Aucune catégorie où classer : on paie, et la dépense reste à imputer. Voir l'exception
  // documentée en tête de fichier.
  if (input.availableCount <= 0) return { ok: true, categoryId: null };

  return { ok: false, categoryId: null, reason: BUDGET_CLASSIFY_PROMPT };
}

function pick(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t || null;
}

/**
 * FAUT-IL DEMANDER À L'ÉCRAN ? — la même question, posée avant le clic.
 *
 * L'écran et le serveur répondent par la MÊME fonction : deux règles séparées auraient divergé,
 * et l'on aurait fini avec un bouton qui promet un paiement que le serveur refuse.
 */
export function needsBudgetChoice(input: BudgetGateInput): boolean {
  return !budgetGate(input).ok;
}
