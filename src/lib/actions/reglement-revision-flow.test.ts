import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

// L'ENTRELACEMENT, rendu déterministe : pendant que le règlement résout le compte payeur (après avoir lu
// l'ordre, avant de l'écrire), le demandeur révise son paiement À LA BAISSE — par le seul réviseur des ordres.
let pendantLeReglement: (() => Promise<unknown>) | null = null;
vi.mock("@/lib/finance/comptes", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/finance/comptes")>();
  return {
    ...vrai,
    compteDeLEcriture: async (input: Parameters<typeof vrai.compteDeLEcriture>[0]) => {
      if (pendantLeReglement) { const f = pendantLeReglement; pendantLeReglement = null; await f(); }
      return vrai.compteDeLEcriture(input);
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { reviserOrdreNonRegle } from "@/lib/payments/revision-ordre";
import { settleExpenseOrder } from "./expense-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LIVRE INSCRIT LE MONTANT QUE L'ORDRE DIT, PAS CELUI QU'IL DISAIT (audit argent 2026-10-27, ARGENT-04).
 *
 * Une révision à la baisse garde l'autorisation du centre. Faite pendant un règlement, elle laissait le
 * règlement écrire l'ANCIEN montant au livre (100 000) sous un ordre qui en dit 80 000. Le règlement
 * doit s'arrêter — rien d'écrit — et le second essai inscrit le bon montant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__reglRevision__${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("settleExpenseOrder — une révision à la baisse pendant le règlement", () => {
  let comptableId = "", envId = "", catId = "", ordreId = "";

  beforeAll(async () => {
    comptableId = (await prisma.user.create({ data: { name: `${TAG}cpt`, email: `${TAG}cpt@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" } })).id;
    ACTEUR = { id: comptableId, name: `${TAG}cpt`, email: `${TAG}cpt@t.dz`, role: "FINANCE_BUDGET_MANAGER", access: await getAccess(comptableId, "FINANCE_BUDGET_MANAGER"), mustChangePassword: false };
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Env`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1_000_000 } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Cat`, allocated: 1_000_000 } })).id;
    ordreId = (await prisma.expenseOrder.create({
      data: { reference: `${TAG}-OD`, label: `${TAG} fournisseur`, amount: 100_000, beneficiary: "SARL Atlas", status: "PENDING", centralStatus: "APPROVED", budgetCategoryId: catId },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const tx = (await prisma.expenseOrder.findMany({ where: { id: ordreId }, select: { transactionId: true } })).map((o) => o.transactionId).filter((x): x is string => Boolean(x));
    await prisma.expenseOrder.deleteMany({ where: { id: ordreId } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ id: { in: tx } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: comptableId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: comptableId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: comptableId } }).catch(() => {});
  });

  it("PRÉMISSE : la baisse garde l'autorisation du centre", async () => {
    const r = await reviserOrdreNonRegle(prisma, ordreId, { montant: 90_000 }, { acteurId: comptableId, raison: "prémisse" });
    expect(r.ok && r.revise && r.rouvert).toBe(false);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).centralStatus).toBe("APPROVED");
    await prisma.expenseOrder.update({ where: { id: ordreId }, data: { amount: 100_000 } });
  });

  it("révisé pendant le règlement : rien n'est écrit au livre ; le second essai inscrit le montant révisé", async () => {
    pendantLeReglement = () => reviserOrdreNonRegle(prisma, ordreId, { montant: 80_000 }, { acteurId: comptableId, raison: "facture définitive" });
    const r = await settleExpenseOrder(fd({ id: ordreId }));
    expect(r.ok).toBe(false);
    expect(await prisma.financeTransaction.count({ where: { label: { startsWith: TAG } } })).toBe(0);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status).toBe("PENDING");

    const encore = await settleExpenseOrder(fd({ id: ordreId }));
    expect(encore.ok, encore.ok ? "" : encore.error).toBe(true);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId }, select: { status: true, amount: true, transactionId: true } });
    expect(o.status).toBe("PAID");
    const ecriture = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: o.transactionId! } });
    expect(Number(ecriture.amount)).toBe(80_000);
    expect(Number(ecriture.amount)).toBe(Number(o.amount));
  });
});
