import { prisma } from "@/lib/prisma";
import { nextFinanceRef } from "@/lib/finance/next-ref";
import { compteDeLEcriture } from "@/lib/finance/comptes";
import { solderLeDossierCompagnon } from "@/lib/finance/compagnon-regle";
import { blockedReason, canDisburse, type CentralStatus } from "@/lib/payments/authorization";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { lienRemiseCaisse } from "@/lib/chemins/moyens-generaux";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REMISE DE CAISSE D'AVANCE ENTRE DANS LA CAISSE DÈS QUE LE CENTRE L'AUTORISE (Direction, 28/10/2026).
 *
 * « Quand on veut remettre une somme dans la caisse d'avance des moyens généraux, ça va dans le centre
 * de paiement ; quand le centre valide, ça doit directement ajouter la somme dans les moyens généraux,
 * et pas aller dans Banque & paiements comme les autres. »
 *
 * Avant : autorisée, la remise (mensuelle ou rallonge) rejoignait la file des Finances, qui la
 * « réglaient » ; la détentrice confirmait ensuite sa réception. Désormais l'autorisation du centre
 * VAUT versement : dans la même transaction, l'ordre passe « réglé », l'écriture de trésorerie
 * (sortie en liquide, non classée — la remise est un changement de tiroir, chaque achat sur la caisse
 * s'impute ensuite à son budget) se pose, et la remise entre dans le fond, en main.
 *
 * UN SEUL ÉCRIVAIN DU VERSEMENT D'UNE REMISE : le centre l'appelle à l'autorisation, et le règlement
 * des Finances (`settleExpenseOrder`) aussi, pour une remise autorisée AVANT cette règle et restée dans
 * leur file — deux chemins qui écriraient chacun leur version finiraient par diverger (§118.5).
 *
 * L'écriture est conditionnelle sur ce qui a été lu (statut, autorisation, montant, bénéficiaire) :
 * deux appels simultanés ne versent qu'une fois, et un ordre annulé ou révisé entre-temps ne verse rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type VersementRemise =
  | { ok: true; dejaVersee: boolean; montant: number; departement: string }
  | { ok: false; error: string };

/**
 * Verse la remise portée par cet ordre — ou rend `null` quand l'ordre ne porte pas de remise de
 * caisse d'avance (l'appelant suit alors son chemin ordinaire).
 */
export async function verserLaRemise(args: {
  orderId: string;
  acteurId: string;
  /** Le compte « payé depuis » choisi par les Finances ; à défaut, le compte principal de l'entité. */
  compteId?: string | null;
  /** Qui verse : le centre à l'autorisation, ou les Finances pour une remise autorisée avant la règle. */
  par: "CENTRE" | "FINANCES";
}): Promise<VersementRemise | null> {
  const remise = await prisma.pettyCashAllotment.findUnique({
    where: { expenseOrderId: args.orderId },
    select: { id: true, holderId: true, amount: true, departmentId: true, department: { select: { name: true } } },
  });
  if (!remise) return null;
  const montant = Number(remise.amount);
  const departement = remise.department.name;

  const order = await prisma.expenseOrder.findUnique({
    where: { id: args.orderId },
    select: { id: true, reference: true, label: true, amount: true, beneficiary: true, category: true, status: true, centralStatus: true, companyId: true },
  });
  if (!order) return { ok: false, error: "Ordre introuvable." };
  if (order.status === "PAID") return { ok: true, dejaVersee: true, montant, departement };
  if (order.status !== "PENDING") return { ok: false, error: "Cet ordre a été annulé." };
  if (!canDisburse(order.centralStatus as CentralStatus)) {
    return { ok: false, error: blockedReason(order.centralStatus as CentralStatus) ?? "Ce paiement n'est pas autorisé." };
  }

  const reference = await nextFinanceRef();
  const compte = await compteDeLEcriture({ compteId: args.compteId ?? null, compte: "Banque", societeId: order.companyId });
  const maintenant = new Date();
  const verse = await prisma.$transaction(async (tx) => {
    const reserve = await tx.expenseOrder.updateMany({
      where: { id: order.id, status: "PENDING", centralStatus: order.centralStatus, amount: order.amount, beneficiary: order.beneficiary },
      data: { status: "PAID", paidById: args.acteurId, paidDate: maintenant },
    });
    if (reserve.count === 0) return false;
    const ecriture = await tx.financeTransaction.create({
      data: {
        reference, date: maintenant, direction: "OUT",
        category: order.category, label: order.label, amount: order.amount,
        // L'argent sort de la banque en LIQUIDE pour la caisse ; il ne se classe pas au budget.
        method: "CASH", account: "Banque", counterparty: order.beneficiary,
        status: "SETTLED", budgetCategoryId: null, createdById: args.acteurId,
        companyId: order.companyId, treasuryAccountId: compte,
      },
    });
    await tx.expenseOrder.update({ where: { id: order.id }, data: { transactionId: ecriture.id } });
    await tx.pettyCashAllotment.update({ where: { id: remise.id }, data: { transactionId: ecriture.id } });
    // EN MAIN, sans confirmation : la somme est dans la caisse dès l'autorisation (règle du 28/10/2026).
    await tx.pettyCashAllotment.updateMany({
      where: { id: remise.id, status: "ALLOTTED" },
      data: { status: "RECEIVED", receivedAt: maintenant },
    });
    return true;
  });
  if (!verse) {
    const relu = await prisma.expenseOrder.findUnique({ where: { id: order.id }, select: { status: true } });
    if (relu?.status === "PAID") return { ok: true, dejaVersee: true, montant, departement };
    return { ok: false, error: "Cet ordre a changé pendant le versement (annulé, révisé, ou son autorisation a bougé) : rien n'a été versé." };
  }

  await solderLeDossierCompagnon(
    order.id, order.reference, args.acteurId,
    args.par === "CENTRE" ? `Ordre ${order.reference} autorisé par le centre de paiement : la somme rejoint la caisse d'avance.` : undefined,
  );
  if (remise.holderId) {
    await notifyUser({
      userId: remise.holderId, type: "ASSIGNMENT", title: "Caisse d'avance créditée",
      body: `${montant.toLocaleString("fr-FR")} DZD ajoutés à la caisse ${departement}${args.par === "CENTRE" ? ", autorisés par le centre de paiement" : ""}.`,
      link: lienRemiseCaisse(remise.id),
    });
  }
  await recordAudit({
    actorId: args.acteurId, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: remise.departmentId,
    summary: `Caisse d'avance créditée — ${montant} DZD (${order.reference}, ${args.par === "CENTRE" ? "à l'autorisation du centre de paiement" : "réglée par les Finances"})`,
  });
  return { ok: true, dejaVersee: false, montant, departement };
}
