import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
// Le seuil des BC est un réglage global : le banc l'injecte (0 = tout BC passe au centre) sans toucher la base partagée.
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 0 }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";
import { addAdProItem, submitAdProItem, decideAdProItem, requestAdProItemOrder, approveAdProItemOrder } from "@/lib/actions/ad-pro-item-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE VALIDATION AD & PRO S'OUVRE AU DG PAR SON RÔLE SECONDAIRE (Direction, 27/10 — point 26).
 *
 * `siegeAuCentreAdPro` ne lisait que le rôle principal : une directrice dont la casquette de Directeur Général est
 * posée en second ne pouvait pas viser un BC. Joué par les vrais points d'entrée, avec le témoin : la même personne
 * sans ce rôle secondaire est refusée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__centre2nd__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

suite("centre de validation Ad & Pro — le DG en rôle secondaire vise un BC", () => {
  let kamId = "", pmId = "", opsId = "", astId = "", dgSecondId = "", eventId = "", catId = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"], secondaryRole: SessionUser["role"] | null = null) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, secondaryRole, passwordHash: "x" } });
    const [kam, pm, ops, ast, dg2] = await Promise.all([
      mk("kam", "MEDICAL_DELEGATE"), mk("pm", "PRODUCT_MANAGER"), mk("ops", "DIRECTION"), mk("ast", "DIRECTION_ASSISTANT"),
      mk("dg2", "PRODUCT_MANAGER", "GENERAL_MANAGER"),
    ]);
    kamId = kam.id; pmId = pm.id; opsId = ops.id; astId = ast.id; dgSecondId = dg2.id;
    const annee = new Date().getUTCFullYear();
    eventId = (await prisma.event.create({
      data: { name: `${TAG}Journée`, requesterId: kamId, status: "VALIDATED", requestStatus: "APPROVED", startDate: new Date(`${annee}-12-04`) }, select: { id: true },
    })).id;
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${RUN}Enveloppe`, modules: ["EVENTS"], totalAmount: 10_000_000, periodStart: new Date(`${annee}-01-01`), periodEnd: new Date(`${annee}-12-31`) },
      select: { id: true },
    });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Événements`, module: "EVENTS", allocated: 5_000_000 }, select: { id: true } })).id;
  });

  afterAll(async () => {
    const comptes = [kamId, pmId, opsId, astId, dgSecondId].filter(Boolean);
    const postes = (await prisma.adProItem.findMany({ where: { eventId }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    const demandes = await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: postes } }, select: { id: true } }).catch(() => []);
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [eventId, ...postes] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);

  it("LE TEST DE LA DIRECTION : un DG en rôle secondaire vise le BC d'un poste", async () => {
    ACTOR = await acteur(kamId);
    const a = await addAdProItem(undefined, fd({ parent: "EVENT", parentId: eventId, kind: "PRINTING", label: `${TAG}Affiches`, amountEstimated: "250000", supplier: "Imprimerie Alpha" }));
    ok(a);
    const id = a.id!;
    ok(await submitAdProItem(undefined, fd({ id })));
    // UN SEUL TEMPS depuis le 27/10/2026 : la Direction Marketing accepte le poste.
    ACTOR = await acteur(pmId);
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "250000", budgetCategoryId: catId })));
    ACTOR = await acteur(kamId);
    ok(await requestAdProItemOrder(undefined, fd({ id, note: "Devis DV-7.", assistantId: astId })));
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id } })).orderStage).toBe("REQUESTED");

    // Le témoin : la même casquette principale, SANS le rôle secondaire, est refusée.
    const sansSecond = { ...(await acteur(dgSecondId)), secondaryRole: null };
    expect(siegeAuCentreAdPro(sansSecond)).toBe(false);
    ACTOR = sansSecond;
    const refus = await approveAdProItemOrder(undefined, fd({ id, decision: "APPROVE" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/centre de validation Ad & Pro/);

    const dg2 = await acteur(dgSecondId);
    expect(dg2.role).toBe("PRODUCT_MANAGER");
    expect(siegeAuCentreAdPro(dg2)).toBe(true);
    expect(userCan(dg2, "AD_PRO_CENTRE", "VIEW"), "le module s'ouvre par le rôle secondaire").toBe(true);
    ACTOR = dg2;
    ok(await approveAdProItemOrder(undefined, fd({ id, decision: "APPROVE" })));
    const apres = await prisma.adProItem.findUniqueOrThrow({ where: { id } });
    expect(apres.orderStage).toBe("DIRECTION_OK");
    expect(apres.orderDirectionById).toBe(dgSecondId);
  });
});
