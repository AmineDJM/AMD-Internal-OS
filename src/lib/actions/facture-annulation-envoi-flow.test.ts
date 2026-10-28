import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ANNULER ET ENVOYER AU RÈGLEMENT LA MÊME FACTURE, AU MÊME INSTANT (audit 27/10/2026, reste de DONNEES-05).
 *
 * `cancelLegalDocument` lisait la facture (sans ordre), puis écrivait « annulée » par le seul identifiant, sans la
 * clé d'envoi au règlement ; `sendLegalInvoiceToSettlement` émettait l'ordre puis le liait sans relire le statut.
 * Entrelacés, ils laissaient une facture ANNULÉE au-dessus d'un ordre de dépense vivant — un paiement sans pièce.
 *
 * L'invariant : une facture annulée n'a aucun ordre vivant ; une facture non annulée en a exactement un — vérifié
 * sur une annulation venue d'un autre processus pendant l'émission (déterministe), puis sur dix courses dans ce
 * processus (la file `enSerie` commune).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));
// L'ENTRELACEMENT ENTRE DEUX PROCESSUS, rendu déterministe : pendant que l'envoi émet l'ordre (après avoir lu la
// facture, avant de la lier), une annulation venue d'ailleurs passe — `enSerie` ne la voit pas, elle est ailleurs.
let pendantLEmission: (() => Promise<unknown>) | null = null;
vi.mock("@/modules/finances/infra/expense-orders", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/modules/finances/infra/expense-orders")>();
  return {
    ...vrai,
    createExpenseOrder: async (...args: Parameters<typeof vrai.createExpenseOrder>) => {
      if (pendantLEmission) { const f = pendantLEmission; pendantLEmission = null; await f(); }
      return vrai.createExpenseOrder(...args);
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { cancelLegalDocument, sendLegalInvoiceToSettlement } from "./legal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zfacrace${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let saId = "";

suite("Facture — annulation et envoi au règlement simultanés", () => {
  beforeAll(async () => {
    saId = (await prisma.user.create({ data: { name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    ACTEUR = { id: saId, name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(saId, "SUPER_ADMIN") } as unknown as CurrentUser;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const factures = (await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((f) => f.id);
    await prisma.legalDocument.updateMany({ where: { id: { in: factures } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceId: { in: factures } }, select: { id: true } })).map((o) => o.id);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: factures } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: saId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: saId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: saId } }).catch(() => {});
  }, 60_000);

  it("annulée par un autre processus pendant l'émission : l'ordre émis est annulé, la facture reste sans paiement", async () => {
    const f = await prisma.legalDocument.create({
      data: { title: `${TAG} facture croisée`, kind: "INVOICE", status: "ACTIVE", amount: 70_000, counterparty: "SARL Atlas", direction: "OUT", createdById: saId },
    });
    pendantLEmission = () => prisma.legalDocument.update({ where: { id: f.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "contestée" } });
    const r = await sendLegalInvoiceToSettlement(fd({ id: f.id }));
    expect(r.ok).toBe(false);
    const lue = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id }, select: { status: true, expenseOrderId: true } });
    expect(lue).toEqual({ status: "CANCELLED", expenseOrderId: null });
    expect(await prisma.expenseOrder.count({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: f.id, status: { not: "CANCELLED" } } })).toBe(0);
  });

  it("une facture annulée n'a jamais d'ordre vivant ; une facture envoyée en a exactement un", async () => {
    for (let i = 0; i < 10; i++) {
      const f = await prisma.legalDocument.create({
        data: { title: `${TAG} facture ${i}`, kind: "INVOICE", status: "ACTIVE", amount: 50_000, counterparty: "SARL Atlas", direction: "OUT", createdById: saId },
      });
      await Promise.all([
        cancelLegalDocument(fd({ id: f.id, reason: "contestée" })),
        sendLegalInvoiceToSettlement(fd({ id: f.id })),
      ]);
      const lue = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id }, select: { status: true } });
      const vivants = await prisma.expenseOrder.count({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: f.id, status: { not: "CANCELLED" } } });
      expect([lue.status, vivants], `course ${i}`).toEqual(lue.status === "CANCELLED" ? ["CANCELLED", 0] : [lue.status, 1]);
    }
  }, 120_000);
});
