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
 * DEUX DEVIS SUR LES MÊMES CASES, ACCEPTÉS ENSEMBLE : UN SEUL ORDRE (audit 2026-10-27, DONNEES-08).
 *
 * ARGENT-02 a fermé le double clic sur LE MÊME devis. Reste la course entre deux devis DIFFÉRENTS qui couvrent
 * le même hôtel : le PDG accepte A pendant que le DG accepte B ; chacun lisait l'autre « en attente » et les
 * deux émettaient leur ordre — le même hôtel payé deux fois. Les cases se prennent désormais sous verrou.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__devisRivaux__${Date.now().toString(36)}`;
const fdOf = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

suite("decideCareQuote — deux devis rivaux acceptés ensemble, un seul ordre", () => {
  let dirId = "", intId = "", envId = "", catId = "", devisA = "", devisB = "", hotel = "";

  beforeAll(async () => {
    dirId = (await prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } })).id;
    ACTOR = { id: dirId, name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", access: await getAccess(dirId, "DIRECTION"), mustChangePassword: false };
    // Une demande internationale PRÉVALIDÉE (statut d'origine, sans instance), une personne accordée, un hôtel.
    intId = (await prisma.congressInternational.create({ data: { name: `${TAG}Int`, requestStatus: "APPROVED", requesterId: dirId, usdDzdRate: 240 }, select: { id: true } })).id;
    const personne = (await prisma.careBeneficiary.create({ data: { congressInternationalId: intId, firstName: "Nora", lastName: `${TAG}Voyageuse`, status: "APPROVED" } })).id;
    hotel = (await prisma.careCell.create({ data: { beneficiaryId: personne, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Paris", currency: "USD" } })).id;
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["CONGRESS_INTERNATIONAL"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000 },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Congrès`, module: "CONGRESS_INTERNATIONAL", allocated: 5_000_000 } })).id;
    const devis = (fournisseur: string, montant: number) => prisma.careQuote.create({
      data: {
        congressInternationalId: intId, supplier: `${TAG}${fournisseur}`, amountDzd: montant, amount: montant / 240, currency: "USD",
        cells: { create: [{ cellId: hotel }] },
      },
    });
    [devisA, devisB] = (await Promise.all([devis("Hôtel A", 120_000), devis("Hôtel B", 110_000)])).map((d) => d.id);
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

  it("le PDG accepte A, le DG accepte B, au même instant → un seul ordre, et l'hôtel porte son devis", async () => {
    const accepter = (id: string) => decideCareQuote(undefined, fdOf({ id, decision: "ACCEPTED", budgetCategoryId: catId }));
    const [a, b] = await Promise.all([accepter(devisA), accepter(devisB)]);
    expect([a.ok, b.ok].filter(Boolean).length, JSON.stringify([a, b])).toBe(1);

    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "CONGRESS_INTERNATIONAL", sourceId: intId }, select: { id: true } });
    expect(ordres).toHaveLength(1);
    const gagnant = a.ok ? devisA : devisB;
    const perdant = a.ok ? devisB : devisA;
    const [g, p, caseHotel] = await Promise.all([
      prisma.careQuote.findUniqueOrThrow({ where: { id: gagnant }, select: { status: true, expenseOrderId: true } }),
      prisma.careQuote.findUniqueOrThrow({ where: { id: perdant }, select: { status: true, expenseOrderId: true } }),
      prisma.careCell.findUniqueOrThrow({ where: { id: hotel }, select: { quoteId: true, expenseOrderId: true } }),
    ]);
    expect(g).toEqual({ status: "ACCEPTED", expenseOrderId: ordres[0].id });
    expect(p.expenseOrderId).toBeNull();
    expect(p.status).not.toBe("ACCEPTED");
    expect(caseHotel).toEqual({ quoteId: gagnant, expenseOrderId: ordres[0].id });
  });
});
