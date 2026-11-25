import { prisma } from "@/lib/prisma";
import { apercuSuppression } from "@/lib/admin-delete-registry";
import { societesAffichees } from "@/lib/queries/budget";
import { toNumber } from "@/lib/utils";
import { STATUTS_ORDRE_ENGAGES } from "./engage";

/**
 * L'APERÇU CHIFFRÉ D'UNE SUPPRESSION D'ENVELOPPE — lu AVANT de confirmer (§118.53), et relu à chaque ouverture du
 * panneau : ce qui part (ses lignes et leur alloué), ce qui RESTE mais redevient « à imputer » (dépenses imputées,
 * engagements, tout ce qui désigne ses lignes), et le refus éventuel — le MÊME inventaire que la suppression
 * (`apercuSuppression` du registre), pour que l'écran n'annonce jamais un périmètre que le geste dépasserait.
 */
export interface ApercuEnveloppe {
  nom: string;
  societe: string | null;
  total: number;
  lignes: number;
  alloue: number;
  depenses: { nombre: number; montant: number };
  engagements: { nombre: number; montant: number };
  /** « 3 écritures comptables », « 1 ordre de dépense »… — ce qui perd son imputation (rétablie à la restauration). */
  aImputer: string[];
  refus: string | null;
}

export async function lireApercuEnveloppe(id: string): Promise<ApercuEnveloppe | null> {
  const env = await prisma.budgetEnvelope.findUnique({
    where: { id },
    select: { name: true, companyId: true, totalAmount: true, categories: { select: { id: true, parentId: true, allocated: true } } },
  });
  if (!env) return null;
  const ids = env.categories.map((c) => c.id);
  const dans = { in: ids };
  const [ecritures, depensesDep, engages, registre, societe] = await Promise.all([
    ids.length ? prisma.financeTransaction.aggregate({ where: { direction: "OUT", budgetCategoryId: dans }, _count: true, _sum: { amount: true } }) : null,
    ids.length ? prisma.departmentBudgetExpense.aggregate({ where: { budgetCategoryId: dans }, _count: true, _sum: { amount: true } }) : null,
    ids.length ? prisma.expenseOrder.aggregate({ where: { budgetCategoryId: dans, status: { in: [...STATUTS_ORDRE_ENGAGES] } }, _count: true, _sum: { amount: true } }) : null,
    apercuSuppression("BUDGET_ENVELOPE", id),
    societesAffichees(),
  ]);
  return {
    nom: env.name,
    societe: societe(env.companyId),
    total: toNumber(env.totalAmount),
    lignes: ids.length,
    alloue: env.categories.filter((c) => c.parentId === null).reduce((s, c) => s + toNumber(c.allocated), 0),
    depenses: {
      nombre: (ecritures?._count ?? 0) + (depensesDep?._count ?? 0),
      montant: toNumber(ecritures?._sum.amount ?? 0) + toNumber(depensesDep?._sum.amount ?? 0),
    },
    engagements: { nombre: engages?._count ?? 0, montant: toNumber(engages?._sum.amount ?? 0) },
    aImputer: registre.detache,
    refus: registre.refus,
  };
}
