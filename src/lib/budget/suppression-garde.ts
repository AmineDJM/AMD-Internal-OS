import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * SUPPRIMER UNE CATÉGORIE OU UNE ENVELOPPE NE DÉTRUIT AUCUNE DÉPENSE (audit données 2026-10-27).
 *
 * `BudgetExpenseLine.categoryId` est en `onDelete: Cascade`, comme `BudgetCategoryLine.parentId` et
 * `BudgetCategoryLine.envelopeId`. Supprimer une enveloppe ou une catégorie de tête emportait donc, en
 * silence et sans corbeille, chaque dépense budgétaire saisie dessous — BV réglementaires « payés le »,
 * frais de mission, saisies manuelles — alors que l'écran promettait « les dépenses repasseront en
 * « à imputer » ». C'est vrai pour les écritures de trésorerie (`FinanceTransaction`, SetNull), faux
 * pour ces lignes-là : la consommation de l'année perdait des montants que personne ne retrouvait.
 *
 * La règle : tant qu'une dépense budgétaire vit dans le sous-arbre, la suppression est REFUSÉE avec
 * son nombre ; on déplace (ré-impute) ou on supprime ces lignes d'abord, geste qui, lui, est journalisé.
 * Une enveloppe qui porte un lot d'intégration Ad & Pro est refusée de même — la clé étrangère
 * (`Restrict`) le faisait déjà, mais par une exception non rattrapée (page d'erreur au lieu d'un message).
 *
 * ATOMIQUE : les catégories visées sont verrouillées (`FOR UPDATE`) avant le comptage, dans la
 * transaction de la suppression. Une dépense ajoutée au même instant attend le verrou (sa clé
 * étrangère prend un `FOR KEY SHARE` sur la catégorie) : elle est comptée, ou elle échoue sur une
 * catégorie disparue — jamais effacée sans qu'on le sache.
 */

type Tx = Prisma.TransactionClient;

/** Les catégories du sous-arbre : la catégorie et toutes ses descendantes, ou toutes celles de l'enveloppe. */
async function sousArbre(tx: Tx, cible: { envelopeId: string } | { categoryId: string }): Promise<string[]> {
  if ("envelopeId" in cible) {
    const cats = await tx.budgetCategoryLine.findMany({ where: { envelopeId: cible.envelopeId }, select: { id: true } });
    return cats.map((c) => c.id);
  }
  const ids = [cible.categoryId];
  let front = [cible.categoryId];
  while (front.length > 0) {
    const enfants = await tx.budgetCategoryLine.findMany({ where: { parentId: { in: front } }, select: { id: true } });
    front = enfants.map((e) => e.id).filter((id) => !ids.includes(id));
    ids.push(...front);
  }
  return ids;
}

/** Le motif du refus, ou `null` quand rien de compté ne serait détruit. À appeler DANS la transaction de la suppression. */
export async function refusSuppressionBudget(tx: Tx, cible: { envelopeId: string } | { categoryId: string }): Promise<string | null> {
  const ids = await sousArbre(tx, cible);
  if (ids.length > 0) {
    await tx.$queryRaw`SELECT "id" FROM "BudgetCategoryLine" WHERE "id" = ANY(${ids}::text[]) FOR UPDATE`;
  }
  const depenses = ids.length > 0 ? await tx.budgetExpenseLine.count({ where: { categoryId: { in: ids } } }) : 0;
  const lots = "envelopeId" in cible ? await tx.adProIntegrationLot.count({ where: { envelopeId: cible.envelopeId } }) : 0;
  const quoi = "envelopeId" in cible ? "Cette enveloppe" : "Cette catégorie";
  if (depenses > 0) {
    return `${quoi} porte ${depenses} dépense(s) budgétaire(s) saisie(s) : la supprimer les effacerait de la consommation. Ré-imputez-les ou supprimez-les d'abord.`;
  }
  if (lots > 0) {
    return `${quoi} porte ${lots} lot(s) d'intégration Ad & Pro : elle ne se supprime pas. Désactivez-la plutôt.`;
  }
  return null;
}

/** Supprime sous la garde : `{ ok: false, error }` si une dépense ou un lot vit dessous, sinon supprime dans la même transaction. */
export async function supprimerSousGarde(
  cible: { envelopeId: string } | { categoryId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return prisma.$transaction(async (tx) => {
    const refus = await refusSuppressionBudget(tx, cible);
    if (refus) return { ok: false as const, error: refus };
    if ("envelopeId" in cible) await tx.budgetEnvelope.delete({ where: { id: cible.envelopeId } });
    else await tx.budgetCategoryLine.delete({ where: { id: cible.categoryId } });
    return { ok: true as const };
  });
}
