import { prisma } from "@/lib/prisma";
import { massByDepartment, budgetRefreshes, refreshSummary, type PayrollCostLine } from "../domaine/payroll-mass";
import { entryCost } from "../domaine/payroll-cost";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAIE APRÈS LE CENTRE DE PAIEMENT — ce que le règlement d'un virement fait côté RH (§118.176).
 *
 * Deux gestes, appelés par le RÈGLEMENT de l'ordre (`settleExpenseOrder`) et par lui seul :
 * poser le FAIT du virement sur le virement lui-même, et actualiser la masse salariale.
 *
 * Ils vivaient dans l'action de paie, au « transfert au budget » qui écrivait un décaissement
 * salarié par salarié. Ce transfert n'existe plus : la paie part au centre comme une demande, et
 * c'est son règlement qui la fait sortir de la banque — une seule écriture, de la somme déclarée.
 * Écrire en plus une écriture par salarié compterait la même paie deux fois au livre.
 *
 * Pas dans un fichier `"use server"` : ces fonctions ne vérifient pas qui appelle — leurs
 * appelants l'ont fait —, et tout ce qu'un tel fichier exporte est une porte publique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * RECALCULER LA MASSE SALARIALE DE L'ANNÉE, département par département — et l'ÉCRIRE.
 *
 * Par ENTITÉ aussi, mais indirectement et c'est voulu : un département appartient à une société,
 * donc la masse d'une société est la somme de celle de ses départements. Poser un second total
 * par entité créerait une deuxième vérité, qui divergerait au premier rattachement corrigé.
 *
 * On REMPLACE, jamais on n'incrémente : incrémenter supposerait de ne jamais régler deux fois, de
 * ne jamais corriger une ligne, de ne jamais annuler un salaire — les trois arrivent. Recalculer
 * rend l'opération idempotente, et une correction se répercute d'elle-même.
 *
 * Rend la phrase que le journal retient.
 */
export async function actualiserMasseSalariale(year: number, actorId: string): Promise<string> {
  const paid = await prisma.payrollEntry.findMany({
    where: { year, status: "PAID" },
    select: {
      gross: true, bonuses: true, deductions: true, employerCost: true,
      employee: { select: { departmentId: true, companyId: true } },
    },
  });
  const lignes: PayrollCostLine[] = paid.map((e) => ({
    departmentId: e.employee?.departmentId ?? null,
    companyId: e.employee?.companyId ?? null,
    cost: entryCost({
      employerCost: e.employerCost != null ? Number(e.employerCost) : null,
      gross: Number(e.gross), bonuses: Number(e.bonuses), deductions: Number(e.deductions),
    }),
  }));
  const { byDepartment } = massByDepartment(lignes);

  const existantes = await prisma.departmentBudget.findMany({
    where: { year, kind: "HR" },
    select: { departmentId: true, amount: true },
  });
  const current = new Map(existantes.map((b) => [b.departmentId, Number(b.amount)]));
  const aEcrire = budgetRefreshes(byDepartment, current);

  for (const r of aEcrire) {
    await prisma.departmentBudget.upsert({
      where: { departmentId_year_kind: { departmentId: r.departmentId, year, kind: "HR" } },
      create: { departmentId: r.departmentId, year, kind: "HR", amount: r.amount, setById: actorId },
      // REMPLACEMENT, jamais `increment` : c'est toute la règle.
      update: { amount: r.amount, setById: actorId },
    }).catch((e) => console.error("[paie] masse salariale non actualisée", r.departmentId, e));
  }
  return refreshSummary(aEcrire, (n) => `${n.toLocaleString("fr-FR")} DZD`);
}

/**
 * LE VIREMENT EST RÉGLÉ — on en garde le fait, et la masse salariale suit.
 *
 * `paidAt` et `transactionId` survivent à la purge de l'historique des règlements : sans eux, une
 * paie virée dont l'ordre a disparu redeviendrait « à envoyer ». L'écriture est CONDITIONNELLE
 * (`paidAt: null`) : régler deux fois le même ordre est déjà refusé en amont, et un second
 * passage ici ne réécrirait pas la date du premier.
 *
 * Les salariés ne sont pas prévenus ici : le planificateur le fait, au plus tôt 24 h après la
 * saisie de leur salaire et seulement maintenant que leur virement est réglé
 * (`clauseSalairesVersesANotifier`). Le prévenir ici court-circuiterait la marge de correction.
 */
export async function solderVirementPaie(wireId: string, transactionId: string, actorId: string): Promise<void> {
  const wire = await prisma.payrollWire.findUnique({ where: { id: wireId }, select: { id: true, year: true } });
  if (!wire) return;
  await prisma.payrollWire.updateMany({
    where: { id: wireId, paidAt: null },
    data: { paidAt: new Date(), transactionId },
  });
  await actualiserMasseSalariale(wire.year, actorId).catch((e) => {
    // La masse se recalcule au prochain virement : elle ne doit jamais faire échouer un règlement
    // déjà inscrit au livre.
    console.error("[paie] masse salariale non actualisée après le virement", e);
  });
}

/**
 * L'INSTANT DE LA BASCULE — depuis quand la paie passe par le centre de paiement (§118.176).
 *
 * Posé une fois par la migration, jamais déplacé : avant lui, « marquer payé » voulait dire
 * « versé » (voir `saisiAvantLeCentre`). Lu par l'écran de la paie, par l'envoi au centre et par
 * l'annonce aux salariés — trois lectures du même fait, une seule requête écrite.
 */
export async function instantDuCentreDePaie(): Promise<Date | null> {
  const s = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { payrollCentreSince: true } });
  return s?.payrollCentreSince ?? null;
}
