import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { decideHrLeave } from "./hr-document-actions";

/**
 * UN CONGÉ ANNUEL ACCORDÉ À DEUX CLICS NE DÉBITE LE SOLDE QU'UNE FOIS (audit données 2026-10-27).
 *
 * `applyAnnualLeaveBalance` lisait `balanceAppliedAt` en JS, débitait, puis posait le verrou : deux
 * « Accorder » simultanés débitaient tous deux — 20 jours retirés pour un congé de 10.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__congedbl__${Date.now()}`;
let rhId = "", employeeId = "", reqId = "";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

suite("decideHrLeave — double clic sur « Accorder » un congé annuel", () => {
  beforeAll(async () => {
    const rh = await prisma.user.create({ data: { name: `${TAG}rh`, email: `${TAG}rh@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    rhId = rh.id;
    ACTOR = { id: rh.id, name: rh.name, email: rh.email, role: "SUPER_ADMIN", access: await getAccess(rh.id, "SUPER_ADMIN"), mustChangePassword: false };
    employeeId = (await prisma.employee.create({ data: { fullName: `${TAG} salarié`, leaveBalanceDays: 30 } })).id;
    reqId = (await prisma.hrDocumentRequest.create({
      data: { employeeId, type: "ANNUAL_LEAVE", periodStart: new Date("2026-11-02"), periodEnd: new Date("2026-11-11"), periodDays: 10 },
    })).id;
  });

  afterAll(async () => {
    await prisma.hrDocumentRequest.deleteMany({ where: { employeeId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employeeId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: rhId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("deux décisions simultanées → 10 jours débités, pas 20", async () => {
    await Promise.all([decideHrLeave(form({ id: reqId, decision: "APPROVE" })), decideHrLeave(form({ id: reqId, decision: "APPROVE" }))]);
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { leaveBalanceDays: true } });
    expect(Number(e.leaveBalanceDays)).toBe(20);
    const r = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: reqId }, select: { balanceAppliedAt: true, status: true } });
    expect(r.balanceAppliedAt).not.toBeNull();
    expect(r.status).toBe("APPROVED");
  });
});
