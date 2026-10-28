import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { settleExpenseOrder } from "@/lib/actions/expense-actions";
import { decidePaymentRequest } from "@/lib/actions/payment-request-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PAIEMENT NE SORT QU'UNE FOIS, MÊME À DEUX CLICS OU À DEUX COMPTABLES (audit 2026-10-24).
 *
 * `settleExpenseOrder` lisait le statut en tête puis écrivait la sortie d'argent plusieurs `await`
 * plus loin ; `decidePaymentRequest` jugeait le geste sur le statut lu puis écrivait par l'id seul.
 * Lancés en même temps, deux règlements posaient DEUX écritures de trésorerie pour un ordre — le
 * solde et la consommation du budget comptaient le paiement deux fois. Ce banc les lance VRAIMENT
 * en même temps, par les vrais points d'entrée (§118.204), et compte ce qui a été écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__reglconc__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

suite("Règlements simultanés — une seule sortie d'argent, une seule décision", () => {
  let sa = "";
  let categorie = "";

  beforeAll(async () => {
    sa = (await prisma.user.create({ data: { name: `${RUN} sa`, email: `${RUN}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN} Fonctionnement`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000,
        categories: { create: [{ name: `${TAG} Frais`, module: "FINANCES", allocated: 10_000_000 }] },
      },
      include: { categories: true },
    });
    categorie = env.categories[0].id;
    ACTOR = await acteur(sa, "SUPER_ADMIN");
  }, 60_000);

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { reference: { startsWith: TAG } }, select: { transactionId: true } });
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({
      where: { OR: [{ id: { in: ordres.map((o) => o.transactionId).filter((x): x is string => !!x) } }, { label: { startsWith: TAG } }] },
    }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { reference: { startsWith: TAG } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: sa } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: sa } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: sa } }).catch(() => {});
  }, 60_000);

  it("cinq règlements lancés ensemble sur un ordre autorisé : UNE écriture, l'ordre payé une fois, chacun reçoit « réglé »", async () => {
    const ordre = await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}OD${RUN.slice(-5)}`, label: `${TAG} facture unique`, amount: 54_321, category: "AUTRE", status: "PENDING",
        centralStatus: "APPROVED", budgetCategoryId: categorie, requiresInvoice: false,
      },
    });

    const resultats = await Promise.all(Array.from({ length: 5 }, () => settleExpenseOrder(fd({ id: ordre.id }))));
    for (const r of resultats) expect(r.ok, r.error).toBe(true);

    const ecritures = await prisma.financeTransaction.count({ where: { label: `${TAG} facture unique`, direction: "OUT" } });
    expect(ecritures, "une seule sortie d'argent pour un seul ordre").toBe(1);
    const apres = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } });
    expect(apres.status).toBe("PAID");
    expect(apres.transactionId, "l'ordre pointe sur l'écriture créée").toBeTruthy();
    expect(await prisma.financeTransaction.count({ where: { id: apres.transactionId! } })).toBe(1);
  }, 60_000);

  it("un ordre dont le centre retire l'autorisation pendant le règlement ne se règle pas", async () => {
    const ordre = await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}OR${RUN.slice(-5)}`, label: `${TAG} autorisation retirée`, amount: 1_000, category: "AUTRE", status: "PENDING",
        centralStatus: "AWAITING", budgetCategoryId: categorie, requiresInvoice: false, requestedById: sa,
      },
    });
    const r = await settleExpenseOrder(fd({ id: ordre.id }));
    expect(r.ok).toBe(false);
    expect(await prisma.financeTransaction.count({ where: { label: `${TAG} autorisation retirée` } })).toBe(0);
  });

  it("trois décisions lancées ensemble sur une demande de paiement : une seule s'écrit, les autres sont prévenues", async () => {
    const req = await prisma.paymentRequest.create({
      data: { reference: `${TAG}PAY${RUN.slice(-5)}`, title: `${TAG} demande`, amount: 9_000, payee: "Fournisseur test", status: "SUBMITTED", requesterId: sa },
    });
    const resultats = await Promise.all(Array.from({ length: 3 }, () => decidePaymentRequest(fd({ id: req.id, move: "REVIEW" }))));
    const passees = resultats.filter((r) => r.ok);
    expect(passees.length, JSON.stringify(resultats)).toBe(1);
    for (const r of resultats.filter((x) => !x.ok)) expect(r.error).toBeTruthy();
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("UNDER_REVIEW");
    expect(await prisma.paymentRequestEvent.count({ where: { requestId: req.id, kind: "REVIEW" } }), "une seule trace de décision").toBe(1);
  }, 60_000);
});
