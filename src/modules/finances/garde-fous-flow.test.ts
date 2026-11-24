import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR, requireModule: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createExpenseOrder } from "./infra/expense-orders";
import { decidePayment } from "./actions-centre";
import { settleExpenseOrder } from "./actions-depenses";
import { chargerCentre } from "./infra/requetes/centre-paiement";
import { signauxDeFractionnement } from "./infra/requetes/fractionnement";
import { approbateursEnAmont } from "./infra/approbateurs-amont";
import {
  PAYMENT_CENTRE_REFUSAL, REFUS_AUTORISER_SA_DEMANDE, REFUS_AUTORISER_SON_APPROBATION, REFUS_REGLER_SON_AUTORISATION,
} from "./partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GARDE-FOUS DE L'ARGENT, JOUÉS PAR LES VRAIS POINTS D'ENTRÉE (Super Admin, 24/11/2026) — avant toute délégation
 * de pouvoirs aux directeurs :
 *   1. le centre de paiement est réservé à la Direction générale (le DG et le Super Admin) ;
 *   2. séparation des tâches personne par personne : qui demande ou a approuvé en amont n'autorise pas ; qui autorise
 *      ne paie pas — le Super Admin excepté ;
 *   3. anti-fractionnement : le cumul sur 30 jours du même demandeur au même bénéficiaire est signalé et journalisé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__gardefous__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${RUN}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("garde-fous de l'argent : centre de la Direction générale, séparation des tâches, fractionnement", () => {
  const u: Record<string, string> = {};
  const roles = { dg: "GENERAL_MANAGER", pdg: "DIRECTION", fin: "FINANCE_BUDGET_MANAGER", sa: "SUPER_ADMIN", dem: "PRODUCT_MANAGER" } as const;
  const ordres: string[] = [];
  let envId = "", catId = "", validationId = "";
  let reglagesAvant: { separationTachesPaiement: boolean; adProDgThreshold: unknown } | null = null;
  const comme = async (k: keyof typeof roles) => { ACTEUR = await session(u[k], roles[k]); };
  const ordre = async (o: { label: string; amount: number; requestedById?: string; beneficiary?: string; sourceType?: string; sourceId?: string }) => {
    const r = await createExpenseOrder({
      label: `${TAG}${o.label}`, amount: o.amount, category: "FOURNISSEUR", beneficiary: o.beneficiary ?? `${RUN} Fournisseur`,
      requestedById: o.requestedById ?? u.dem, budgetCategoryId: catId,
      // Justificatif obligatoire (24/11/2026) : sans pièce, l'ordre attend hors du centre — le décor joint sa facture.
      justificatif: { fichier: new File([`facture ${Math.random()}`], "facture.pdf", { type: "application/pdf" }), nature: "INVOICE" },
      ...(o.sourceType ? { sourceType: o.sourceType as never, sourceId: o.sourceId } : {}),
    });
    ordres.push(r.id);
    return r.id;
  };

  beforeAll(async () => {
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, passwordHash: "x", role: role as never }, select: { id: true } })).id;
    }
    reglagesAvant = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { separationTachesPaiement: true, adProDgThreshold: true } });
    // La règle telle qu'elle est livrée : séparation active, porte DG à 1 M DZD.
    await prisma.appSetting.upsert({
      where: { id: "global" }, create: { id: "global", separationTachesPaiement: true, adProDgThreshold: 1_000_000 },
      update: { separationTachesPaiement: true, adProDgThreshold: 1_000_000 },
    });
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Env`, modules: ["FINANCES"], periodStart: new Date("2020-01-01"), periodEnd: new Date("2099-12-31"), totalAmount: 50_000_000 } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Cat`, allocated: 50_000_000 } })).id;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    if (reglagesAvant) {
      await prisma.appSetting.update({ where: { id: "global" }, data: { separationTachesPaiement: reglagesAvant.separationTachesPaiement, adProDgThreshold: reglagesAvant.adProDgThreshold as never } }).catch(() => {});
    }
    const comptes = Object.values(u);
    const lus = await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { transactionId: true } });
    if (validationId) await prisma.validationRequest.deleteMany({ where: { id: validationId } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ id: { in: lus.map((l) => l.transactionId).filter((x): x is string => Boolean(x)) } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
  }, 60_000);

  it("1. le PDG (DIRECTION) et les Finances sont refusés au centre — file comprise ; le DG décide", async () => {
    const o = await ordre({ label: "Imprimerie", amount: 120_000 });
    for (const k of ["pdg", "fin"] as const) {
      await comme(k);
      expect((await chargerCentre(ACTEUR as SessionUser, {})).canDecide, k).toBe(false);
      expect(await decidePayment(fd({ id: o, decision: "APPROVE" })), k).toEqual({ ok: false, error: PAYMENT_CENTRE_REFUSAL });
    }
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o } })).centralStatus, "rien n'est écrit").toBe("AWAITING");
    await comme("dg");
    expect((await chargerCentre(ACTEUR as SessionUser, {})).canDecide).toBe(true);
    const r = await decidePayment(fd({ id: o, decision: "APPROVE" }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o } })).centralDecidedById).toBe(u.dg);
  });

  it("2. le DG qui a autorisé ne marque pas payé ; les Finances, si", async () => {
    const o = await ordre({ label: "Traiteur", amount: 80_000 });
    await comme("dg");
    expect((await decidePayment(fd({ id: o, decision: "APPROVE" }))).ok).toBe(true);
    expect(await settleExpenseOrder(fd({ id: o }))).toEqual({ ok: false, error: REFUS_REGLER_SON_AUTORISATION });
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o } })).status).toBe("PENDING");
    await comme("fin");
    const p = await settleExpenseOrder(fd({ id: o }));
    expect(p.ok, p.error).toBe(true);
  });

  it("3. le DG n'autorise pas SA demande : l'autre membre de la Direction générale (le Super Admin) le fait", async () => {
    const o = await ordre({ label: "Billet du DG", amount: 60_000, requestedById: u.dg });
    await comme("dg");
    expect(await decidePayment(fd({ id: o, decision: "APPROVE" }))).toEqual({ ok: false, error: REFUS_AUTORISER_SA_DEMANDE });
    expect(REFUS_AUTORISER_SA_DEMANDE).toMatch(/autre membre de la Direction générale/);
    await comme("sa");
    const r = await decidePayment(fd({ id: o, decision: "APPROVE" }));
    expect(r.ok, r.error).toBe(true);
  });

  it("4. qui a APPROUVÉ la demande en amont (validation) ne l'autorise pas au centre ; le Super Admin, si — et peut payer ce qu'il a autorisé", async () => {
    const source = `${RUN}-demande-admin`;
    validationId = (await prisma.validationRequest.create({
      data: {
        reference: `${RUN}-VAL`, module: "Demandes administratives", title: `${TAG} achat`, requesterId: u.dem, status: "APPROVED",
        entityType: "ADMIN_REQUEST", entityId: source, steps: { create: [{ order: 1, validatorId: u.dg, status: "APPROVED", decidedAt: new Date() }] },
      },
      select: { id: true },
    })).id;
    const o = await ordre({ label: "Achat validé par le DG", amount: 90_000, sourceType: "ADMIN_REQUEST", sourceId: source });
    expect(await approbateursEnAmont({ id: o, sourceType: "ADMIN_REQUEST", sourceId: source })).toEqual([u.dg]);
    await comme("dg");
    expect(await decidePayment(fd({ id: o, decision: "APPROVE" }))).toEqual({ ok: false, error: REFUS_AUTORISER_SON_APPROBATION });
    // Refuser reste permis : refuser n'engage rien. (On ne le fait pas ici — le Super Admin autorise.)
    await comme("sa");
    expect((await decidePayment(fd({ id: o, decision: "APPROVE" }))).ok).toBe(true);
    const p = await settleExpenseOrder(fd({ id: o }));
    expect(p.ok, p.error).toBe(true);
  });

  it("5. FRACTIONNEMENT : trois demandes de 400 000 au même bénéficiaire en un mois — signalées, journalisées, sans re-routage", async () => {
    const beneficiaire = `${RUN} SARL Fraction`;
    const [a, b, c] = [
      await ordre({ label: "Lot 1", amount: 400_000, beneficiary: beneficiaire }),
      await ordre({ label: "Lot 2", amount: 400_000, beneficiary: beneficiaire }),
      await ordre({ label: "Lot 3", amount: 400_000, beneficiary: beneficiaire }),
    ];
    const t = Date.now();
    // Hors de la ligne budgétaire des cas précédents (qui les lierait aussi) : ici, c'est le BÉNÉFICIAIRE qui lie.
    await prisma.expenseOrder.updateMany({ where: { id: { in: [a, b, c] } }, data: { budgetCategoryId: null } });
    await prisma.expenseOrder.update({ where: { id: a }, data: { createdAt: new Date(t - 20 * 86_400_000) } });
    await prisma.expenseOrder.update({ where: { id: b }, data: { createdAt: new Date(t - 10 * 86_400_000) } });
    const signal = (await signauxDeFractionnement([c])).get(c);
    expect(signal?.cumul).toBe(1_200_000);
    expect(signal?.liees.map((l) => l.id).sort()).toEqual([a, b].sort());
    // Un ordre seul, à un autre bénéficiaire, n'est pas signalé.
    const seul = await ordre({ label: "Seul", amount: 400_000, beneficiary: `${RUN} Autre` });
    await prisma.expenseOrder.update({ where: { id: seul }, data: { budgetCategoryId: null } });
    expect((await signauxDeFractionnement([seul])).has(seul)).toBe(false);

    await comme("dg");
    const r = await decidePayment(fd({ id: c, decision: "APPROVE" }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/Possible fractionnement : 3 demandes/);
    // L'ordre n'est pas re-routé : il est autorisé, et seul le signal est gardé au journal.
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: c } })).centralStatus).toBe("APPROVED");
    const trace = await prisma.auditLog.findFirst({ where: { entityId: c, field: "fractionnement" }, select: { summary: true, newValue: true } });
    expect(trace?.summary).toMatch(/sous signal de fractionnement/);
    expect(trace?.newValue).toBeTruthy();
  });
});
