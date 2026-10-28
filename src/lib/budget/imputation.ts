import { arrondirAuCentime } from "@/lib/utils";
/**
 * OÙ TOMBE CHAQUE DINAR D'UN TICKET DE CAISSE.
 *
 * L'assistante de direction achète pour le département : un ticket, plusieurs articles. La
 * Direction, elle, lit un budget découpé en catégories. Entre les deux il manquait une règle —
 * et sans règle, on classe soit tout le ticket d'un bloc (« courses : 40 000 DZD » dans une
 * seule case, alors qu'il contenait du papier, un taxi et de l'eau), soit rien du tout.
 *
 * La règle tient en trois lignes, et elle est faite pour que les nombres TOMBENT JUSTE :
 *
 *   1. un article classé compte pour SON montant, dans SA catégorie ;
 *   2. ce qui n'est pas classé article par article — le RESTE du ticket — tombe dans la
 *      catégorie du ticket, quand elle est renseignée ;
 *   3. ce qui reste après ça est « à classer » : visible, jamais silencieux, jamais réparti
 *      au hasard dans une catégorie voisine.
 *
 * La somme des imputations d'une dépense égale TOUJOURS son montant. C'est la propriété qui
 * garantit qu'aucune dépense ne disparaît d'un budget ni n'y compte deux fois — l'erreur
 * classique quand on additionne à la fois le total du ticket et le détail de ses lignes.
 *
 * Module PUR — testé. Aucun accès base : c'est cette fonction, et non une requête, qui porte
 * la règle, et c'est elle qu'on relit quand un total surprend.
 */

/** Deux décimales : un ticket ne se compte pas au millième de dinar. */

export interface ImputableLine {
  /** Catégorie budgétaire de CET article — `null` = pas classé individuellement. */
  budgetCategoryId?: string | null;
  amount: number;
}

export interface ImputableExpense {
  /** Montant total de la dépense (celui du justificatif). */
  amount: number;
  /** Catégorie du ticket entier — sert de destination au reste non classé. */
  budgetCategoryId?: string | null;
  lines?: ImputableLine[];
}

export interface Imputation {
  /** `null` = à classer : la Direction le voit, personne ne le devine à sa place. */
  categoryId: string | null;
  amount: number;
}

/**
 * Comment UNE dépense se répartit entre les catégories budgétaires.
 *
 * Les articles classés d'abord, le reste ensuite. On regroupe par catégorie : deux articles
 * de la même catégorie sur un même ticket font une seule imputation, pas deux lignes qu'il
 * faudrait ré-additionner à l'affichage.
 */
export function imputationsOf(expense: ImputableExpense): Imputation[] {
  const total = arrondirAuCentime(Math.max(0, Number.isFinite(expense.amount) ? expense.amount : 0));
  const byCategory = new Map<string, number>();
  // Ce qu'il reste À RÉPARTIR. Le détail ne peut pas dépasser le justificatif : si une saisie
  // incohérente (correction en cours) donne des articles plus lourds que le ticket, on s'arrête
  // au montant réellement payé plutôt que de consommer un budget pour de l'argent jamais sorti.
  let left = total;

  for (const line of expense.lines ?? []) {
    if (left <= 0) break;
    const catId = line.budgetCategoryId ?? null;
    if (!catId) continue;
    const amount = Number.isFinite(line.amount) ? line.amount : 0;
    if (amount <= 0) continue;
    const take = arrondirAuCentime(Math.min(amount, left));
    byCategory.set(catId, arrondirAuCentime((byCategory.get(catId) ?? 0) + take));
    left = arrondirAuCentime(left - take);
  }

  const rest = arrondirAuCentime(Math.max(0, left));

  const out: Imputation[] = [...byCategory.entries()].map(([categoryId, amount]) => ({ categoryId, amount }));
  if (rest > 0) {
    const restCategory = expense.budgetCategoryId ?? null;
    if (restCategory) {
      const existing = out.find((i) => i.categoryId === restCategory);
      if (existing) existing.amount = arrondirAuCentime(existing.amount + rest);
      else out.push({ categoryId: restCategory, amount: rest });
    } else {
      out.push({ categoryId: null, amount: rest });
    }
  }
  return out;
}

/**
 * Ce que ces dépenses consomment, catégorie par catégorie — le chiffre que lit la page Budgets.
 *
 * Le non-classé n'y figure pas : il n'appartient à aucune catégorie, et l'y faire entrer
 * gonflerait une enveloppe de dépenses qu'elle n'a jamais reçues.
 */
export function consumptionByCategory(expenses: readonly ImputableExpense[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of expenses) {
    for (const imp of imputationsOf(e)) {
      if (!imp.categoryId) continue;
      out.set(imp.categoryId, arrondirAuCentime((out.get(imp.categoryId) ?? 0) + imp.amount));
    }
  }
  return out;
}

/**
 * Ce qui n'est encore rattaché à aucune catégorie. Ce chiffre a sa propre alerte : une dépense
 * réelle mais non classée est un trou dans la lecture du budget, pas une dépense de moins.
 */
export function unclassifiedTotal(expenses: readonly ImputableExpense[]): number {
  let sum = 0;
  for (const e of expenses) {
    for (const imp of imputationsOf(e)) {
      if (imp.categoryId === null) sum = arrondirAuCentime(sum + imp.amount);
    }
  }
  return sum;
}

/**
 * La dépense est-elle ENTIÈREMENT classée ? Sert à marquer une ligne « à classer » dans les
 * moyens généraux, là où la correction se fait — pas six écrans plus loin.
 */
export function isFullyClassified(expense: ImputableExpense): boolean {
  return imputationsOf(expense).every((i) => i.categoryId !== null);
}
