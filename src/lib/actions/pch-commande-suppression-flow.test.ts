import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * UN BON DE COMMANDE PCH NE S'EFFACE PLUS SANS TRACE (audit 27/10/2026, DONNEES-15).
 *
 * `deleteOrder` faisait `pchOrder.delete` : la cascade emportait lignes et livraisons, les mouvements de stock
 * perdaient leur bon de livraison, et rien ne disait qui l'avait fait. Désormais : refusé quand une livraison est
 * réceptionnée ; sinon à la corbeille (lignes et livraisons attendues comprises), restaurable.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { deleteOrder } from "./pch-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zpchcmd${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let saId = "", tenderId = "";

suite("deleteOrder (PCH) — livré : refusé ; sinon à la corbeille", () => {
  beforeAll(async () => {
    saId = (await prisma.user.create({ data: { name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    ACTEUR = { id: saId, name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(saId, "SUPER_ADMIN") } as unknown as CurrentUser;
    tenderId = (await prisma.pchTender.create({ data: { reference: `${TAG}-AO` } })).id;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    await prisma.pchTender.deleteMany({ where: { id: tenderId } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { deletedById: saId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: saId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: saId } }).catch(() => {});
  }, 60_000);

  it("une commande livrée est refusée ; ses livraisons restent", async () => {
    const livree = await prisma.pchOrder.create({ data: { tenderId, reference: `${TAG}-BC1`, deliveries: { create: { deliveredAt: new Date(), reference: `${TAG}-BL` } } } });
    const r = await deleteOrder(fd({ id: livree.id }));
    expect(r.ok ? "" : r.error).toMatch(/livraison\(s\) réceptionnée\(s\)/);
    expect(await prisma.pchDelivery.count({ where: { orderId: livree.id } })).toBe(1);
  });

  it("une commande non livrée part à la corbeille, tracée, avec sa livraison attendue", async () => {
    const attendue = await prisma.pchOrder.create({ data: { tenderId, reference: `${TAG}-BC2`, deliveries: { create: { expectedAt: new Date() } } } });
    const r = await deleteOrder(fd({ id: attendue.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.pchOrder.count({ where: { id: attendue.id } })).toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "PCH_ORDER", sourceId: attendue.id } });
    expect(rec.lot).not.toBeNull();
  });
});
