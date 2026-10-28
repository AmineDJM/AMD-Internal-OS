import type { PaymentRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { companionStatusForOrder } from "@/lib/finance/dossier-auto";

/**
 * LE DOSSIER COMPAGNON PASSE À « SOLDÉ » quand son ordre est réglé, et le fil le dit.
 *
 * Best-effort : un dossier qui ne se met pas à jour ne doit jamais annuler un virement déjà
 * inscrit. C'est la même hiérarchie que partout dans ce circuit — l'argent prime, l'affichage
 * se rattrape. Partagé par les deux écrivains d'un règlement : les Finances (`settleExpenseOrder`)
 * et le versement d'une remise de caisse à l'autorisation du centre (`general-means/verser-remise.ts`).
 */
export async function solderLeDossierCompagnon(orderId: string, orderRef: string, actorId: string, message?: string): Promise<void> {
  try {
    const dossiers = await prisma.paymentRequest.findMany({
      where: { expenseOrderId: orderId, origin: "EXPENSE_ORDER" },
      select: { id: true },
    });
    if (dossiers.length === 0) return;
    const ids = dossiers.map((d) => d.id);
    await prisma.paymentRequest.updateMany({
      where: { id: { in: ids } },
      data: { status: companionStatusForOrder("PAID") as PaymentRequestStatus },
    });
    await prisma.paymentRequestEvent.createMany({
      data: ids.map((requestId) => ({
        requestId, actorId, kind: "APPROVE" as const,
        message: message ?? `Ordre ${orderRef} réglé par les Finances.`,
      })),
    });
  } catch (e) {
    console.error("[expense] dossier compagnon non synchronisé", e);
  }
}
