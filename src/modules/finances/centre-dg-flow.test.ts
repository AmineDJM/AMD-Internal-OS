import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR, requireModule: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { createExpenseOrder } from "./infra/expense-orders";
import { decidePayment } from "./actions-centre";
import { chargerCentre } from "./infra/requetes/centre-paiement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE PAIEMENT « DIRECTION GÉNÉRALE » ACCUEILLE LE DG (Direction, 27/10 — point 24).
 *
 * Le Directeur Général (`GENERAL_MANAGER`) y siège avec le Super Admin ; la Direction (PDG) y reste. Joué par les
 * vrais points d'entrée : le DG ouvre le module, voit l'ordre en attente, l'autorise ; il est prévenu quand un ordre
 * arrive. Le témoin : le Directeur des opérations, lui, n'y siège pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__centredg__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${RUN}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("le centre de paiement accueille le Directeur Général", () => {
  let dgId = "", dirId = "", opsId = "", demandeurId = "";
  const ordres: string[] = [];

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${RUN}${s}@t.dz`, passwordHash: "x", role: role as never }, select: { id: true } });
    const [dg, dir, ops, dem] = await Promise.all([mk("dg", "GENERAL_MANAGER"), mk("dir", "DIRECTION"), mk("ops", "OPERATIONS_DIRECTOR"), mk("dem", "PRODUCT_MANAGER")]);
    dgId = dg.id; dirId = dir.id; opsId = ops.id; demandeurId = dem.id;
  });

  afterAll(async () => {
    const comptes = [dgId, dirId, opsId, demandeurId].filter(Boolean);
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it("LE TEST DE LA DIRECTION : le DG voit l'ordre en attente et l'autorise", async () => {
    const ordre = await createExpenseOrder({ label: `${TAG}Imprimerie`, amount: 120_000, category: "FOURNISSEUR", beneficiary: "Imprimerie Atlas", requestedById: demandeurId });
    ordres.push(ordre.id);
    expect(ordre.centralStatus).toBe("AWAITING");
    // Il est prévenu, comme le PDG.
    expect(await prisma.notification.count({ where: { userId: dgId, title: "Autorisation de paiement demandée", body: { contains: ordre.reference } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: dirId, title: "Autorisation de paiement demandée", body: { contains: ordre.reference } } })).toBe(1);

    const dg = await session(dgId, "GENERAL_MANAGER");
    expect(userCan(dg, "PAYMENT_CENTRE", "VIEW"), "le module s'ouvre").toBe(true);
    const centre = await chargerCentre(dg, {});
    expect(centre.canDecide).toBe(true);
    expect(centre.aucunOrdre).toBe(false);

    ACTEUR = dg;
    const r = await decidePayment(fd({ id: ordre.id, decision: "APPROVE" }));
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id }, select: { centralStatus: true, centralDecidedById: true } });
    expect(apres).toEqual({ centralStatus: "APPROVED", centralDecidedById: dgId });
  });

  it("la Direction y reste ; le Directeur des opérations n'y siège pas (le témoin)", async () => {
    const ordre = await createExpenseOrder({ label: `${TAG}Traiteur`, amount: 80_000, category: "FOURNISSEUR", beneficiary: "Traiteur", requestedById: demandeurId });
    ordres.push(ordre.id);
    ACTEUR = await session(opsId, "OPERATIONS_DIRECTOR");
    const refus = await decidePayment(fd({ id: ordre.id, decision: "APPROVE" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/Directeur Général/);
    ACTEUR = await session(dirId, "DIRECTION");
    const r = await decidePayment(fd({ id: ordre.id, decision: "APPROVE" }));
    expect(r.ok, r.error).toBe(true);
  });
});
