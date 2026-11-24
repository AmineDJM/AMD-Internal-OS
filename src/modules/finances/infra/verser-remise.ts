import { prisma } from "@/lib/prisma";
import { nextFinanceRef } from "./next-ref";
import { compteDeLEcriture } from "./comptes";
import { solderLeDossierCompagnon } from "./compagnon-regle";
import { blockedReason, canDisburse, type CentralStatus } from "../domaine/authorization";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { lienRemiseCaisse } from "@/lib/chemins/moyens-generaux";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PAIEMENT D'UNE REMISE DE CAISSE D'AVANCE PAR LES FINANCES — l'argent sort de la banque ; il
 * n'entre dans la caisse qu'à la confirmation du caissier (Super Admin, 24/11/2026).
 *
 * « Quand les Finances marquent payé, ET que le caissier confirme la réception, c'est à ce moment-là
 * que la somme compte dans la caisse. »
 *
 * La règle du 28/10/2026 (l'autorisation du centre valait versement, la remise entrait en main sans
 * confirmation) est RETIRÉE : autorisée, la remise rejoint la file des Finances comme tout ordre.
 * Quand elles la marquent payée (`settleExpenseOrder`), dans la même transaction : l'ordre passe
 * « réglé », l'écriture de trésorerie se pose (sortie en liquide, non classée — la remise est un
 * changement de tiroir, chaque achat sur la caisse s'impute ensuite à son budget). La remise, elle,
 * reste « à confirmer » (`ALLOTTED`) : hors du solde tant que le caissier n'a pas confirmé l'avoir en
 * main (`confirmPettyCashReceipt`). Il en est prévenu ici.
 *
 * Une remise de nouveau payée après un « non payé » (l'annulation du paiement par les Finances) se
 * reconfirme : l'argent reçu la première fois n'est plus celui qui vient de partir.
 *
 * UN SEUL ÉCRIVAIN DU VERSEMENT D'UNE REMISE (§118.5). L'écriture est conditionnelle sur ce qui a été
 * lu (statut, autorisation, montant, bénéficiaire) : deux appels simultanés ne versent qu'une fois,
 * et un ordre annulé ou révisé entre-temps ne verse rien.
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
    // PAYÉE ≠ REÇUE : la remise reste à confirmer par le caissier. Seule une remise confirmée puis
    // « non payée » (paiement défait) repasse à confirmer — la première payée l'est déjà.
    await tx.pettyCashAllotment.updateMany({
      where: { id: remise.id, status: "RECEIVED" },
      data: { status: "ALLOTTED", receivedAt: null },
    });
    return true;
  });
  if (!verse) {
    const relu = await prisma.expenseOrder.findUnique({ where: { id: order.id }, select: { status: true } });
    if (relu?.status === "PAID") return { ok: true, dejaVersee: true, montant, departement };
    return { ok: false, error: "Cet ordre a changé pendant le versement (annulé, révisé, ou son autorisation a bougé) : rien n'a été versé." };
  }

  await solderLeDossierCompagnon(order.id, order.reference, args.acteurId);
  if (remise.holderId) {
    await notifyUser({
      userId: remise.holderId, type: "VALIDATION_REQUIRED", title: "Caisse d'avance payée — confirmez la réception",
      body: `${montant.toLocaleString("fr-FR")} DZD payés par les Finances pour la caisse ${departement} : confirmez les avoir reçus, ils compteront alors dans la caisse.`,
      link: lienRemiseCaisse(remise.id),
    });
  }
  await recordAudit({
    actorId: args.acteurId, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: remise.departmentId,
    summary: `Caisse d'avance — remise de ${montant} DZD payée par les Finances (${order.reference}), à confirmer par le caissier`,
  });
  return { ok: true, dejaVersee: false, montant, departement };
}
