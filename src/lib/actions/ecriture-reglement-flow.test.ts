import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { deleteTransaction, updateTransaction, updateTransactionStatus } from "./finance-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRITURE D'UN RÈGLEMENT NE SE SUPPRIME NI NE CHANGE DE MONTANT (audit argent 2026-10-27, ARGENT-05).
 *
 * Un ordre PAYÉ pointe l'écriture que son règlement a posée. La supprimer, ou en changer le montant, le
 * sens ou le statut, laissait l'ordre payé et une trésorerie qui ne le compte plus. Le TÉMOIN : une
 * écriture libre (saisie à la main) se corrige et se supprime comme avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__ecrReglement__${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("finance-actions — l'écriture d'un règlement est figée sur ses montants", () => {
  let cptId = "", reglee = "", libre = "", ordre = "";
  const ecriture = (suffixe: string) => prisma.financeTransaction.create({
    data: { reference: `${TAG}-${suffixe}`, date: new Date(), direction: "OUT", category: "FOURNISSEUR", label: `${TAG} ${suffixe}`, amount: 50_000, method: "BANK_TRANSFER", account: "Banque", status: "SETTLED" },
    select: { id: true },
  }).then((t) => t.id);

  beforeAll(async () => {
    cptId = (await prisma.user.create({ data: { name: `${TAG}cpt`, email: `${TAG}cpt@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" } })).id;
    ACTEUR = { id: cptId, name: `${TAG}cpt`, email: `${TAG}cpt@t.dz`, role: "FINANCE_BUDGET_MANAGER", access: await getAccess(cptId, "FINANCE_BUDGET_MANAGER"), mustChangePassword: false };
    reglee = await ecriture("R");
    libre = await ecriture("L");
    ordre = (await prisma.expenseOrder.create({
      data: { reference: `${TAG}-OD`, label: `${TAG} fournisseur`, amount: 50_000, status: "PAID", centralStatus: "APPROVED", transactionId: reglee, paidById: cptId, paidDate: new Date() },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    await prisma.expenseOrder.deleteMany({ where: { id: ordre } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: cptId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: cptId } }).catch(() => {});
  });

  it("supprimer l'écriture d'un ordre payé → refusé, elle reste", async () => {
    const r = await deleteTransaction(fd({ id: reglee }));
    expect(r.ok === false && r.error).toMatch(/règlement de l'ordre/);
    expect(await prisma.financeTransaction.count({ where: { id: reglee } })).toBe(1);
  });

  it("en changer le montant ou le statut → refusé ; corriger son libellé → accepté", async () => {
    const montant = await updateTransaction(fd({ id: reglee, label: `${TAG} R`, amount: "30000", category: "FOURNISSEUR", direction: "OUT" }));
    expect(montant.ok).toBe(false);
    const statut = await updateTransactionStatus(fd({ id: reglee, status: "CANCELLED" }));
    expect(statut.ok).toBe(false);
    const libelle = await updateTransaction(fd({ id: reglee, label: `${TAG} R — facture 12`, amount: "50000", category: "FOURNISSEUR", direction: "OUT" }));
    expect(libelle.ok, libelle.ok ? "" : libelle.error).toBe(true);
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: reglee } });
    expect(Number(t.amount)).toBe(50_000);
    expect(t.status).toBe("SETTLED");
  });

  it("TÉMOIN : une écriture libre se corrige et se supprime", async () => {
    expect((await updateTransaction(fd({ id: libre, label: `${TAG} L`, amount: "30000", category: "FOURNISSEUR", direction: "OUT" }))).ok).toBe(true);
    expect((await deleteTransaction(fd({ id: libre }))).ok).toBe(true);
    expect(await prisma.financeTransaction.count({ where: { id: libre } })).toBe(0);
  });
});
