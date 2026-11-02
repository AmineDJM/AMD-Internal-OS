import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { decideCareQuote } from "./actions-prise-en-charge";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN DEVIS DE PRISE EN CHARGE N'ÉMET QU'UN ORDRE, MÊME À DEUX CLICS (audit argent 2026-10-27, ARGENT-02).
 *
 * Deux acceptations simultanées du même devis, par la VRAIE action : un seul ordre de dépense naît, et
 * c'est celui que le devis porte. Avant le correctif, les deux passaient la lecture « pas encore engagé »
 * et émettaient chacune un ordre au centre de paiement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__devis2clics__${Date.now().toString(36)}`;
const fdOf = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

suite("decideCareQuote — deux acceptations simultanées, un seul ordre", () => {
  let dirId = "", intId = "", envId = "", catId = "", quoteId = "";

  beforeAll(async () => {
    dirId = (await prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } })).id;
    ACTOR = { id: dirId, name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", access: await getAccess(dirId, "DIRECTION"), mustChangePassword: false };
    // Une demande internationale PRÉVALIDÉE (statut d'origine, sans instance), une personne accordée, un hôtel.
    intId = (await prisma.congressInternational.create({ data: { name: `${TAG}Int`, requestStatus: "APPROVED", requesterId: dirId, usdDzdRate: 240 }, select: { id: true } })).id;
    const personne = (await prisma.careBeneficiary.create({ data: { congressInternationalId: intId, firstName: "Nora", lastName: `${TAG}Voyageuse`, status: "APPROVED" } })).id;
    const hotel = (await prisma.careCell.create({ data: { beneficiaryId: personne, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Paris", currency: "USD" } })).id;
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["CONGRESS_INTERNATIONAL"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000 },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Congrès`, module: "CONGRESS_INTERNATIONAL", allocated: 5_000_000 } })).id;
    quoteId = (await prisma.careQuote.create({
      data: {
        congressInternationalId: intId, supplier: `${TAG}Hôtel`, amountDzd: 120_000, amount: 500, currency: "USD",
        retainedAt: new Date(), retainedById: dirId, cells: { create: [{ cellId: hotel }] },
      },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceId: intId }, select: { id: true } })).map((o) => o.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { expenseOrderId: { in: ordres } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.careQuote.deleteMany({ where: { congressInternationalId: intId } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressInternationalId: intId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: intId } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { id: intId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: dirId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: dirId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: dirId } }).catch(() => {});
  }, 60_000);

  it("deux clics « Accepter » au même instant → un seul ordre, celui que porte le devis", async () => {
    const accepter = () => decideCareQuote(undefined, fdOf({ id: quoteId, decision: "ACCEPTED", budgetCategoryId: catId }));
    const [a, b] = await Promise.all([accepter(), accepter()]);
    expect([a.ok, b.ok].filter(Boolean).length, JSON.stringify([a, b])).toBe(1);

    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "CONGRESS_INTERNATIONAL", sourceId: intId }, select: { id: true, amount: true } });
    expect(ordres).toHaveLength(1);
    expect(Number(ordres[0].amount)).toBe(120_000);
    const devis = await prisma.careQuote.findUniqueOrThrow({ where: { id: quoteId }, select: { status: true, expenseOrderId: true } });
    expect(devis.status).toBe("ACCEPTED");
    expect(devis.expenseOrderId).toBe(ordres[0].id);
  });

  it("un troisième clic, après coup, est refusé et n'émet rien", async () => {
    const r = await decideCareQuote(undefined, fdOf({ id: quoteId, decision: "ACCEPTED", budgetCategoryId: catId }));
    expect(r.ok).toBe(false);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "CONGRESS_INTERNATIONAL", sourceId: intId } })).toBe(1);
  });
});
