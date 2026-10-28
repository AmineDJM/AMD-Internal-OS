/**
 * CORRIGER UNE LIGNE DE PAIE — parce qu'une paie fausse ne se rattrape pas au mois suivant.
 *
 * Jusqu'ici, un mois marqué payé ne se corrigeait pas : on ne pouvait que l'ANNULER en entier
 * (et encore, seulement avant le transfert au budget), puis tout ressaisir — coût employeur,
 * net, brut, fiche de paie. Une erreur de mille dinars sur un net obligeait donc à défaire la
 * ligne, ce que personne ne fait un vendredi soir : on la laissait fausse.
 *
 * Après le transfert au budget, la correction ne s'arrête PAS à la ligne de paie : elle doit
 * suivre jusqu'à l'écriture de trésorerie créée par le transfert. Sinon la paie dit un montant
 * et le budget en dit un autre, et l'on découvre l'écart en fin d'exercice, sans savoir lequel
 * des deux a raison.
 *
 * Depuis §118.176, ce transfert n'existe plus : la paie part au centre de paiement, entité par
 * entité, et son virement — une seule écriture, de la somme DÉCLARÉE — ne suit pas la correction
 * d'une ligne : il dit ce que la banque a réellement versé. `syncBudget` ne concerne donc plus que
 * l'historique de l'ancien transfert, dont chaque ligne porte encore sa propre écriture.
 *
 * Module PUR — testé, sans base de données.
 */

export interface PayrollAmounts {
  /** Ce que la société décaisse réellement : brut + charges patronales. Obligatoire. */
  employerCost: number | null;
  /** Le montant affiché au salarié. Obligatoire. */
  net: number | null;
  /** Ligne de bulletin, facultative. */
  gross: number | null;
}

/**
 * Les trois règles arithmétiques d'un bulletin, en un seul endroit.
 *
 * Elles étaient écrites dans l'action de marquage ; la correction devait les rejouer à
 * l'identique. Recopiées, elles auraient divergé au premier ajustement — et une ligne
 * corrigée aurait pu passer un contrôle que la même ligne créée n'aurait pas passé.
 */
export function validateAmounts(a: PayrollAmounts): string | null {
  if (a.employerCost === null || a.employerCost <= 0) {
    return "Indiquez le coût employeur (brut + charges patronales) — c'est lui qui est imputé au budget.";
  }
  if (a.net === null || a.net <= 0) {
    return "Indiquez le salaire net (montant affiché au salarié).";
  }
  if (a.net > a.employerCost) {
    return "Le salaire net ne peut pas dépasser le coût employeur.";
  }
  // Un brut supérieur au coût employeur est arithmétiquement impossible : les charges
  // patronales s'AJOUTENT au brut, elles ne s'en retranchent pas.
  if (a.gross !== null && a.gross > 0 && a.gross > a.employerCost) {
    return "Le salaire brut ne peut pas dépasser le coût employeur (les charges patronales s'y ajoutent).";
  }
  return null;
}

/**
 * Le brut à inscrire quand il n'a pas été saisi.
 *
 * On reprend le coût employeur plutôt que de laisser un 0 : une ligne à brut nul se lit comme
 * une paie nulle, et fausse tous les états qui retombent sur le brut faute de coût employeur.
 */
export function resolvedGross(a: PayrollAmounts): number {
  return a.gross !== null && a.gross > 0 ? a.gross : (a.employerCost as number);
}

export interface AmendImpact {
  /** Écart de coût employeur : positif = la société décaisse plus qu'annoncé. */
  delta: number;
  /** Le transfert au budget doit-il être corrigé à son tour ? */
  syncBudget: boolean;
  /** Ce qu'on inscrit au journal — lisible sans rouvrir la ligne. */
  summary: string;
}

/**
 * L'effet d'une correction, y compris SUR LE BUDGET.
 *
 * `syncBudget` n'est vrai que si la ligne a réellement été transférée ET que le montant change :
 * corriger un net ou une fiche de paie ne touche pas au budget, et rejouer l'écriture pour rien
 * ferait apparaître un mouvement de trésorerie là où il n'y en a pas eu.
 */
export function amendImpact(
  before: { employerCost: number; net: number },
  after: { employerCost: number; net: number },
  opts: { transferred: boolean },
): AmendImpact {
  const delta = after.employerCost - before.employerCost;
  const parts: string[] = [];
  if (delta !== 0) {
    parts.push(`coût employeur ${before.employerCost.toLocaleString("fr-FR")} → ${after.employerCost.toLocaleString("fr-FR")} DZD`);
  }
  if (after.net !== before.net) {
    parts.push(`net ${before.net.toLocaleString("fr-FR")} → ${after.net.toLocaleString("fr-FR")} DZD`);
  }
  return {
    delta,
    syncBudget: opts.transferred && delta !== 0,
    summary: parts.length > 0 ? parts.join(" · ") : "pièces et mentions corrigées",
  };
}

/**
 * Une ligne se corrige-t-elle ?
 *
 * Oui dès qu'elle existe — payée comme transférée. C'est le point : refuser la correction après
 * le transfert, c'est garantir qu'on vit avec un chiffre faux, puisque personne ne défera un
 * transfert de paie pour mille dinars. Ce qui NE se corrige pas ici, c'est une ligne encore à
 * l'état de brouillon : elle se saisit, elle ne se corrige pas.
 */
export function canAmend(entry: { status: string }): { ok: boolean; error?: string } {
  if (entry.status !== "PAID" && entry.status !== "TRANSFERRED" && entry.status !== "VALIDATED") {
    return { ok: false, error: "Cette ligne n'est pas encore payée : marquez-la payée plutôt que de la corriger." };
  }
  return { ok: true };
}
