import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";

/**
 * LE JOURNAL DE CONSOMMATION D'UN BANC, EFFACÉ — chaque tour joué au faux modèle écrit, comme en
 * production, ses lignes `ModelCallLog` / `AiUsageLog` (feature `assistant_ia`). Un banc les retire
 * pour SES comptes, et seulement eux : effacer par fournisseur (« factice ») effacerait aussi les
 * lignes qu'un banc voisin, en parallèle, est en train de vérifier.
 */
export async function effacerJournalDe(userIds: (string | null | undefined)[]): Promise<void> {
  const ids = userIds.filter((x): x is string => !!x);
  if (!ids.length) return;
  await Promise.all([
    prisma.modelCallLog.deleteMany({ where: { userId: { in: ids }, feature: "assistant_ia" } }).catch(attendu("banc : journal du compte déjà effacé")),
    prisma.aiUsageLog.deleteMany({ where: { userId: { in: ids }, feature: "assistant_ia" } }).catch(attendu("banc : journal du compte déjà effacé")),
    prisma.assistantIaPlafondAtteint.deleteMany({ where: { userId: { in: ids } } }).catch(attendu("banc : journal du compte déjà effacé")),
  ]);
}
