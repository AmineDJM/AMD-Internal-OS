import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES D'ARGENT PASSENT PAR LA PORTE DE L'ORDRE (audit 27/10/2026, lot V3-F).
 *
 *   SA-11 / ARGENT-08 — un comptable cloisonné sur Alpha ne règle, ne reporte, ne relance pas un ordre de Beta ;
 *                       un siège du centre limité à Alpha n'autorise pas un ordre de Beta.
 *   ARGENT-06         — qui a demandé un paiement ne l'autorise pas ; qui l'a demandé ou autorisé ne le règle
 *                       pas — tant que le Super Admin n'a pas suspendu le réglage.
 *   DONNEES-09        — la réponse au centre n'écrase pas une décision rendue pendant qu'on répondait.
 *
 * Banc multi-société (modèle `fiche-rh-entite-ecriture.test.ts`) : un témoin prouve chaque fois que l'acteur a
 * bien le droit du module — c'est l'OBJET qui lui est refusé, pas le geste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));
// L'ENTRELACEMENT, rendu déterministe (DONNEES-09) : quand un siège répond pour le demandeur, la porte de l'ordre
// est franchie APRÈS la lecture et AVANT l'écriture — c'est là qu'un autre siège tranche.
let pendantLaReponse: (() => Promise<unknown>) | null = null;
vi.mock("@/lib/acces/objet", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/acces/objet")>();
  return {
    ...vrai,
    ouvrirPourEcrire: async (...args: Parameters<typeof vrai.ouvrirPourEcrire>) => {
      if (pendantLaReponse) { const f = pendantLaReponse; pendantLaReponse = null; await f(); }
      return vrai.ouvrirPourEcrire(...args);
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { settleExpenseOrder, deferExpenseOrder, resumeExpenseOrder } from "./expense-actions";
import { decidePayment, respondToPaymentCentre } from "./payment-centre-actions";
import { REFUS_AUTORISER_SA_DEMANDE, REFUS_REGLER_SA_DEMANDE, REFUS_REGLER_SON_AUTORISATION } from "@/lib/payments/separation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zargent${Date.now().toString(36)}`;
const ids = { A: "", B: "", cpt: "", siege: "", env: "", cat: "" };
const acteurs: Record<"cpt" | "siege", CurrentUser | null> = { cpt: null, siege: null };
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let n = 0;
const ordre = async (companyId: string, data: Record<string, unknown> = {}) =>
  (await prisma.expenseOrder.create({
    data: { reference: `${TAG}-${++n}`, label: `${TAG} ordre ${n}`, amount: 1000, beneficiary: "SARL Atlas", status: "PENDING", centralStatus: "APPROVED", companyId, budgetCategoryId: ids.cat, ...data },
    select: { id: true },
  })).id;
const separation = (active: boolean) => prisma.appSetting.upsert({
  where: { id: "global" }, create: { id: "global", separationTachesPaiement: active }, update: { separationTachesPaiement: active },
});

suite("Argent : la porte de l'ordre, la séparation des tâches, la réponse au centre", () => {
  let separationAvant = true;

  beforeAll(async () => {
    separationAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { separationTachesPaiement: true } }))?.separationTachesPaiement ?? true;
    await separation(true);
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((nom) => prisma.company.create({ data: { name: `${TAG}${nom}` } })))).map((c) => c.id);
    // Un ordre se règle sur SA catégorie budgétaire (`budgetGate`) : on la pose, le banc juge la porte, pas le budget.
    ids.env = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Env`, modules: ["FINANCES"], periodStart: new Date("2020-01-01"), periodEnd: new Date("2099-12-31"), totalAmount: 1_000_000 } })).id;
    ids.cat = (await prisma.budgetCategoryLine.create({ data: { envelopeId: ids.env, name: `${TAG}Cat`, allocated: 1_000_000 } })).id;
    for (const qui of ["cpt", "siege"] as const) {
      const u = await prisma.user.create({ data: { name: `${TAG} ${qui}`, email: `${TAG}${qui}@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
      ids[qui] = u.id;
      await prisma.employee.create({ data: { fullName: `${TAG} ${qui}`, companyId: ids.A, userId: u.id, isActive: true } });
    }
    await prisma.userAccess.create({ data: { userId: ids.cpt, module: "FINANCES", canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" } });
    await prisma.paymentCentreSeat.create({ data: { userId: ids.siege, note: TAG } });
    for (const qui of ["cpt", "siege"] as const) {
      acteurs[qui] = { id: ids[qui], name: `${TAG} ${qui}`, email: `${TAG}${qui}@t.dz`, role: "COORDINATOR", secondaryRole: null, access: await getAccess(ids[qui], "COORDINATOR") } as unknown as CurrentUser;
    }
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    await separation(separationAvant);
    const tx = (await prisma.expenseOrder.findMany({ where: { reference: { startsWith: TAG } }, select: { transactionId: true } })).map((o) => o.transactionId).filter((x): x is string => Boolean(x));
    await prisma.paymentCentreMessage.deleteMany({ where: { order: { reference: { startsWith: TAG } } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ id: { in: tx } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: ids.env } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [ids.cpt, ids.siege] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.cpt, ids.siege] } } }).catch(() => {});
    await prisma.paymentCentreSeat.deleteMany({ where: { userId: ids.siege } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: [ids.cpt, ids.siege] } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [ids.cpt, ids.siege] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [ids.cpt, ids.siege] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => {});
  }, 60_000);

  it("SA-11 : un ordre de Beta ne se règle, ne se reporte ni ne se relance par un comptable d'Alpha", async () => {
    ACTEUR = acteurs.cpt;
    const b = await ordre(ids.B, { deferredUntil: new Date(Date.now() + 86_400_000) });
    expect((await settleExpenseOrder(fd({ id: b }))).ok).toBe(false);
    expect((await deferExpenseOrder(fd({ id: b, until: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) }))).ok).toBe(false);
    expect((await resumeExpenseOrder(fd({ id: b }))).ok).toBe(false);
    const apres = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: b } });
    expect(apres.status).toBe("PENDING");
    expect(apres.deferredUntil).not.toBeNull();
  });

  it("témoin SA-11 : le même comptable règle un ordre d'Alpha", async () => {
    ACTEUR = acteurs.cpt;
    const a = await ordre(ids.A);
    const r = await settleExpenseOrder(fd({ id: a }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: a } })).status).toBe("PAID");
  });

  it("ARGENT-08 : un siège limité à Alpha n'autorise pas un ordre de Beta ; il autorise celui d'Alpha", async () => {
    ACTEUR = acteurs.siege;
    const b = await ordre(ids.B, { centralStatus: "AWAITING" });
    expect((await decidePayment(fd({ id: b, decision: "APPROVE" }))).ok).toBe(false);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: b } })).centralStatus).toBe("AWAITING");
    const a = await ordre(ids.A, { centralStatus: "AWAITING" });
    const r = await decidePayment(fd({ id: a, decision: "APPROVE" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("ARGENT-06 : le siège n'autorise pas sa propre demande — il peut la refuser", async () => {
    ACTEUR = acteurs.siege;
    const a = await ordre(ids.A, { centralStatus: "AWAITING", requestedById: ids.siege });
    const r = await decidePayment(fd({ id: a, decision: "APPROVE" }));
    expect(r).toEqual({ ok: false, error: REFUS_AUTORISER_SA_DEMANDE });
    const refus = await decidePayment(fd({ id: a, decision: "REFUSE", body: "Je retire ma demande." }));
    expect(refus.ok, refus.ok ? "" : refus.error).toBe(true);
  });

  it("ARGENT-06 : le comptable ne règle ni ce qu'il a demandé, ni ce qu'il a autorisé", async () => {
    ACTEUR = acteurs.cpt;
    const demande = await ordre(ids.A, { requestedById: ids.cpt });
    expect(await settleExpenseOrder(fd({ id: demande }))).toEqual({ ok: false, error: REFUS_REGLER_SA_DEMANDE });
    const autorise = await ordre(ids.A, { centralDecidedById: ids.cpt });
    expect(await settleExpenseOrder(fd({ id: autorise }))).toEqual({ ok: false, error: REFUS_REGLER_SON_AUTORISATION });
    expect(await prisma.expenseOrder.count({ where: { id: { in: [demande, autorise] }, status: "PAID" } })).toBe(0);
  });

  it("ARGENT-06 : suspendue par le Super Admin, la séparation ne bloque plus", async () => {
    await separation(false);
    try {
      ACTEUR = acteurs.siege;
      const a = await ordre(ids.A, { centralStatus: "AWAITING", requestedById: ids.siege });
      expect((await decidePayment(fd({ id: a, decision: "APPROVE" }))).ok).toBe(true);
      ACTEUR = acteurs.cpt;
      const b = await ordre(ids.A, { requestedById: ids.cpt });
      expect((await settleExpenseOrder(fd({ id: b }))).ok).toBe(true);
    } finally {
      await separation(true);
    }
  });

  it("DONNEES-09 : un refus rendu pendant la réponse n'est pas écrasé", async () => {
    // Le siège saisit la réponse reçue par téléphone ; au même instant, le PDG refuse l'ordre.
    ACTEUR = acteurs.siege;
    const a = await ordre(ids.A, { centralStatus: "INFO_REQUESTED", requestedById: ids.cpt });
    pendantLaReponse = () => prisma.expenseOrder.update({ where: { id: a }, data: { centralStatus: "REFUSED" } });
    const r = await respondToPaymentCentre(fd({ id: a, body: "Argumentaire reçu par téléphone." }));
    expect(r.ok).toBe(false);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: a } })).centralStatus).toBe("REFUSED");
    expect(await prisma.paymentCentreMessage.count({ where: { orderId: a } })).toBe(0);
  });

  it("témoin DONNEES-09 : sans décision concurrente, la réponse renvoie l'ordre au centre", async () => {
    ACTEUR = acteurs.cpt;
    const a = await ordre(ids.A, { centralStatus: "INFO_REQUESTED", requestedById: ids.cpt });
    const r = await respondToPaymentCentre(fd({ id: a, body: "Voici l'argumentaire." }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: a } })).centralStatus).toBe("AWAITING");
  });
});
