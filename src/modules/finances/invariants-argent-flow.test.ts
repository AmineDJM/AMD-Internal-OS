import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { createExpenseOrder } from "./infra/expense-orders";
import { decidePayment } from "./actions-centre";
import { settleExpenseOrder } from "./actions-depenses";
import { totauxReglements, violationsArgent, type EcritureInvariant, type OrdreInvariant } from "./domaine/invariants-argent";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INVARIANT GLOBAL DE L'ARGENT SORTI (audit argent 2026-10-27) : Σ des ordres réglés = Σ de leurs
 * écritures, une écriture par ordre, au centime.
 *
 * 1. La règle pure, cas par cas — chaque violation a son exemple.
 * 2. La chaîne RÉELLE, de bout en bout : émission (`createExpenseOrder`), autorisation au centre
 *    (`decidePayment`), règlement (`settleExpenseOrder`) — dont un double clic simultané sur le même
 *    ordre et un ordre que le centre refuse — puis l'invariant sur ce que la base contient.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const o = (id: string, status: string, amount: number, transactionId: string | null): OrdreInvariant => ({ id, reference: `OD-${id}`, status, amount, transactionId });
const e = (id: string, amount: number, direction = "OUT", status = "SETTLED"): EcritureInvariant => ({ id, amount, direction, status });

describe("violationsArgent — la règle pure", () => {
  it("une chaîne saine : aucune violation, et les deux totaux sont égaux", () => {
    const ordres = [o("a", "PAID", 12_345.67, "t1"), o("b", "PAID", 0.1 + 0.2, "t2"), o("c", "PENDING", 9, null), o("d", "CANCELLED", 5, null)];
    const ecritures = [e("t1", 12_345.67), e("t2", 0.3)];
    expect(violationsArgent(ordres, ecritures)).toEqual([]);
    expect(totauxReglements(ordres, ecritures)).toEqual({ ordres: 12_345.97, ecritures: 12_345.97 });
  });
  it("chaque écart a son nom", () => {
    const regles = (ordres: OrdreInvariant[], ecritures: EcritureInvariant[]) => violationsArgent(ordres, ecritures).map((v) => v.regle);
    expect(regles([o("a", "PAID", 10, null)], [])).toEqual(["ORDRE_PAYE_SANS_ECRITURE"]);
    expect(regles([o("a", "PAID", 10, "t")], [])).toEqual(["ECRITURE_INTROUVABLE"]);
    expect(regles([o("a", "PAID", 10, "t")], [e("t", 9.99)])).toEqual(["MONTANT_DIVERGENT"]);
    expect(regles([o("a", "PAID", 10, "t")], [e("t", 10, "IN")])).toEqual(["SENS_OU_STATUT"]);
    expect(regles([o("a", "PAID", 10, "t")], [e("t", 10, "OUT", "CANCELLED")])).toEqual(["SENS_OU_STATUT"]);
    expect(regles([o("a", "PAID", 10, "t"), o("b", "PAID", 10, "t")], [e("t", 10)])).toEqual(["ECRITURE_PARTAGEE", "ECRITURE_PARTAGEE"]);
    expect(regles([o("a", "PENDING", 10, "t")], [e("t", 10)])).toEqual(["ORDRE_NON_PAYE_AVEC_ECRITURE"]);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__invArgent__${Date.now().toString(36)}`;
const fd = (x: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(x)) f.set(k, v); return f; };

suite("la chaîne réelle émission → centre → règlement tient l'invariant", () => {
  const u: Record<string, { id: string; role: UserRole }> = {};
  let envId = "", catId = "";
  const ordres: string[] = [];
  const comme = async (k: string) => {
    const { id, role } = u[k];
    ACTEUR = { id, name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, access: await getAccess(id, role), mustChangePassword: false };
  };

  beforeAll(async () => {
    for (const [k, role] of [["dem", "PRODUCT_MANAGER"], ["pdg", "DIRECTION"], ["cpt", "FINANCE_BUDGET_MANAGER"]] as const) {
      u[k] = { id: (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id, role };
    }
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Env`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000 } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Cat`, allocated: 10_000_000 } })).id;
    for (const amount of [12_345.67, 1_000.1, 250_000, 0.3, 99_999.99]) {
      const ordre = await createExpenseOrder({ label: `${TAG} fournisseur ${amount}`, amount, category: "FOURNISSEUR", beneficiary: "SARL Atlas", requestedById: u.dem.id, budgetCategoryId: catId });
      ordres.push(ordre.id);
    }
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const lus = await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { transactionId: true } });
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ id: { in: lus.map((l) => l.transactionId).filter((x): x is string => Boolean(x)) } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    const ids = Object.values(u).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  it("chaque ordre naît en attente du centre ; le règlement d'un ordre non autorisé est refusé", async () => {
    const nes = await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { centralStatus: true, status: true } });
    expect(nes.every((n) => n.centralStatus === "AWAITING" && n.status === "PENDING")).toBe(true);
    await comme("cpt");
    expect((await settleExpenseOrder(fd({ id: ordres[0] }))).ok).toBe(false);
  });

  it("le centre autorise quatre ordres et en refuse un ; les Finances règlent — un double clic compris", async () => {
    await comme("pdg");
    for (const id of ordres.slice(0, 4)) expect((await decidePayment(fd({ id, decision: "APPROVE" }))).ok).toBe(true);
    expect((await decidePayment(fd({ id: ordres[4], decision: "REFUSE", body: "hors budget" }))).ok).toBe(true);

    await comme("cpt");
    const [a, b] = await Promise.all([settleExpenseOrder(fd({ id: ordres[0] })), settleExpenseOrder(fd({ id: ordres[0] }))]);
    expect(a.ok && b.ok).toBe(true);
    for (const id of ordres.slice(1)) await settleExpenseOrder(fd({ id }));
  });

  it("INVARIANT : une écriture par ordre réglé, au centime, et Σ ordres réglés = Σ écritures", async () => {
    const lus = await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { id: true, reference: true, status: true, amount: true, transactionId: true } });
    const txIds = lus.map((l) => l.transactionId).filter((x): x is string => Boolean(x));
    const ecritures = await prisma.financeTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, amount: true, direction: true, status: true } });
    const ordresLus = lus.map((l) => ({ ...l, amount: Number(l.amount) }));
    const ecrituresLues = ecritures.map((x) => ({ ...x, amount: Number(x.amount) }));

    expect(violationsArgent(ordresLus, ecrituresLues)).toEqual([]);
    expect(lus.filter((l) => l.status === "PAID")).toHaveLength(4);
    expect(lus.find((l) => l.id === ordres[4])?.status).toBe("PENDING");
    const t = totauxReglements(ordresLus, ecrituresLues);
    expect(t.ordres).toBe(12_345.67 + 1_000.1 + 250_000 + 0.3);
    expect(t.ecritures).toBe(t.ordres);
    // Aucune écriture de plus que d'ordres réglés, double clic compris.
    expect(await prisma.financeTransaction.count({ where: { label: { startsWith: TAG } } })).toBe(4);
  });
});
