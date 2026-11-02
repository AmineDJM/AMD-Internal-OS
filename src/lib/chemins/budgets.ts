/**
 * OÙ MÈNE UNE NOTIFICATION DE BUDGET — la demande de dotation d'un département.
 *
 * `/budgets/departements` liste les demandes de dotation / rallonge d'un EXERCICE : l'adresse porte donc
 * l'année de la demande (`?year=`) et son identifiant (`?demande=`) ; l'écran entoure la ligne
 * (`ancreDemandeBudget`). Les écrans d'enveloppes (Budgets, Budget Marketing / Regulatory / Operations)
 * se règlent par `?env=` et, pour une ligne précise de leurs tableaux, par `?cible=<ancre>`.
 *
 * Module PUR — aucune importation.
 */

export const CHEMIN_BUDGETS_DEPARTEMENTS = "/budgets/departements";

export const ancreDemandeBudget = (id: string): string => `demande-budget-${id}`;
export const ancreCategorieBudget = (id: string): string => `categorie-budget-${id}`;

export function lienDemandeBudgetDepartement(requestId?: string | null, year?: number | null): string {
  const q: string[] = [];
  if (year) q.push(`year=${year}`);
  if (requestId) q.push(`demande=${encodeURIComponent(requestId)}`);
  return q.length ? `${CHEMIN_BUDGETS_DEPARTEMENTS}?${q.join("&")}` : CHEMIN_BUDGETS_DEPARTEMENTS;
}

/**
 * Une catégorie ou une dépense d'une enveloppe, sur l'écran d'enveloppes de `base` (`/budgets`,
 * `/budget-marketing`, `/budget-regulatory`, `/budget-operations`).
 */
export function lienCibleEnveloppe(base: string, enveloppeId: string, ancre: string, ecran: "" | "/depenses" = ""): string {
  return `${base}${ecran}?env=${encodeURIComponent(enveloppeId)}&cible=${encodeURIComponent(ancre)}`;
}
