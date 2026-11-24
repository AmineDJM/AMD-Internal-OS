import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR, requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { engagementsDesCategories } from "@/lib/queries/budget-sources";
import { createExpenseOrder } from "./api";
import { decidePayment } from "./actions-centre";
import { settleExpenseOrder } from "./actions-depenses";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AVANCE SUR SALAIRE EST DE LA TRÉSORERIE, PAS UNE CHARGE (contrôle final, 24/11/2026).
 *
 * Même quand une ligne budgétaire des RH existe (celle que le règlement choisirait d'office pour une source RH), l'ordre
 * d'une avance n'y est ni ENGAGÉ tant qu'il attend, ni CONSOMMÉ une fois réglé : la paie qui reprend l'avance consomme
 * déjà la masse salariale — l'imputer aussi compterait la même somme deux fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__avancehb__";
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${TAG}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("avance sur salaire — réglée sans budget", () => {
  const u: Record<string, string> = {};
  let soc = "", cat = "", env = "", ordreId = "", avanceId = "";

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of [["sal", "SALES_USER"], ["rh", "COORDINATOR"], ["dg", "GENERAL_MANAGER"], ["cpt", "FINANCE_BUDGET_MANAGER"]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, passwordHash: "x", role }, select: { id: true } })).id;
    }
    soc = (await prisma.company.create({ data: { name: `${TAG}Société`, shortName: `${TAG}S` } })).id;
    await prisma.userCompanyAccess.create({ data: { userId: u.cpt!, companyId: soc, canEdit: true } });
    const employe = await prisma.employee.create({ data: { fullName: `${TAG}Salarié`, companyId: soc, userId: u.sal! } });
    // La demande du salarié, faite par SA session : elle est son propre justificatif (« demande signée »).
    avanceId = (await prisma.salaryAdvance.create({ data: { employeeId: employe.id, amount: 40_000, status: "APPROVED", createdById: u.sal! } })).id;
    // Une enveloppe RH active : sans la règle, l'avance s'y engagerait puis s'y imputerait d'office.
    env = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}RH`, companyId: soc, modules: ["RH"], periodStart: new Date("2000-01-01"), periodEnd: new Date("2100-12-31"), totalAmount: 1_000_000 } })).id;
    cat = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env, name: `${TAG}Frais RH`, module: "RH", allocated: 1_000_000 } })).id;
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    const societes = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const avances = (await prisma.salaryAdvance.findMany({ where: { employee: { fullName: { startsWith: TAG } } }, select: { id: true } })).map((a) => a.id);
    const ordres = await prisma.expenseOrder.findMany({ where: { OR: [{ companyId: { in: societes } }, { sourceId: { in: avances } }] }, select: { id: true, transactionId: true } });
    const ids = ordres.map((o) => o.id);
    await prisma.document.deleteMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ids } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ordres.map((o) => o.transactionId).filter((t): t is string => Boolean(t)) } } }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: { id: { in: avances } } }).catch(() => {});
    const envs = (await prisma.budgetEnvelope.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((e) => e.id);
    await prisma.budgetExpenseLine.deleteMany({ where: { category: { envelopeId: { in: envs } } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envs } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envs } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...avances] } }, { actor: { email: { startsWith: TAG } } }] } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { id: { in: societes } } }).catch(() => {});
  }

  it("en attente, l'avance n'engage pas la ligne RH ; réglée, elle ne la consomme pas", async () => {
    const o = await createExpenseOrder({
      label: `Avance sur salaire — ${TAG}Salarié`, amount: 40_000, category: "AVANCE", beneficiary: `${TAG}Salarié`,
      sourceType: "SALARY_ADVANCE", sourceId: avanceId, requestedById: u.rh!,
    });
    ordreId = o.id;
    const engage = await engagementsDesCategories([cat], new Date("2100-12-31"));
    expect(engage.parCategorie.get(cat) ?? 0).toBe(0);

    ACTEUR = await session(u.dg!, "GENERAL_MANAGER");
    const d = await decidePayment(fd({ id: ordreId, decision: "APPROVE" }));
    expect(d.ok, d.error).toBe(true);
    ACTEUR = await session(u.cpt!, "FINANCE_BUDGET_MANAGER");
    const s = await settleExpenseOrder(fd({ id: ordreId }));
    expect(s.ok, s.error).toBe(true);

    const regle = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } });
    expect(regle.status).toBe("PAID");
    const ecriture = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: regle.transactionId! } });
    // La trésorerie bouge (40 000 sortent) ; aucun budget ne la compte.
    expect([Number(ecriture.amount), ecriture.direction, ecriture.budgetCategoryId]).toEqual([40_000, "OUT", null]);
    expect(await prisma.financeTransaction.count({ where: { budgetCategoryId: cat } })).toBe(0);
    expect(await prisma.budgetExpenseLine.count({ where: { categoryId: cat } })).toBe(0);
  });
});
