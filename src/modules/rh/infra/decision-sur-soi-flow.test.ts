import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ON NE TRANCHE PAS SA PROPRE DEMANDE RH — par les vraies actions, sur la base réelle (audit sécurité 27/10, SECURITE-ACCES-06).
 * Un compte qui a les droits RH (ici le Super Admin, qui les a tous) présente une avance, une note de frais,
 * un congé : il ne peut ni les accorder lui-même, ni réécrire après coup un congé déjà décidé.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { decideAdvance, updateLeaveRequest } from "@/modules/rh/actions";
import { decideHrLeave, decideExpenseReport } from "@/modules/rh/actions-documents";
import { refusDecisionSurSoi } from "../domaine/decision-sur-soi";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zsursoi${Date.now()}`;
let userId = "";
let employeId = "";
const ids = { avance: "", conge: "", demande: "", frais: "" };
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const erreur = (r: unknown) => (r as { ok: boolean; error?: string }).error ?? "";

describe("refusDecisionSurSoi — la règle pure", () => {
  it("refuse au demandeur, laisse passer un autre et une demande sans compte", () => {
    expect(refusDecisionSurSoi("u1", "u1")).toMatch(/propre demande/);
    expect(refusDecisionSurSoi("u1", "u2")).toBeNull();
    expect(refusDecisionSurSoi(null, "u2")).toBeNull();
  });
});

suite("Décisions RH : jamais sur sa propre demande", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}rh`, email: `${TAG}rh@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    userId = u.id;
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN") } as unknown as CurrentUser;
    employeId = (await prisma.employee.create({ data: { fullName: `${TAG} moi`, baseSalary: 1, userId: u.id, leaveBalanceDays: 30 } })).id;
    ids.avance = (await prisma.salaryAdvance.create({ data: { employeeId: employeId, amount: 50000 } })).id;
    ids.conge = (await prisma.leaveRequest.create({ data: { employeeId: employeId, startDate: new Date("2026-11-02"), endDate: new Date("2026-11-06"), days: 5, type: "ANNUAL", status: "APPROVED" } })).id;
    ids.demande = (await prisma.hrDocumentRequest.create({ data: { employeeId: employeId, type: "ANNUAL_LEAVE" } })).id;
    ids.frais = (await prisma.hrDocumentRequest.create({ data: { employeeId: employeId, type: "EXPENSE_REPORT", expenseMonth: "2026-10", originalsAckAt: new Date() } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.expenseOrder.deleteMany({ where: { sourceId: ids.avance } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }, 60_000);

  it("avance sur salaire : refusée, et toujours en attente", async () => {
    expect(erreur(await decideAdvance(form({ id: ids.avance, decision: "APPROVED" })))).toMatch(/propre demande/);
    expect((await prisma.salaryAdvance.findUnique({ where: { id: ids.avance } }))?.status).toBe("PENDING");
  });

  it("congé déjà accordé : ni réécrit, ni recrédité", async () => {
    expect(erreur(await updateLeaveRequest(form({ id: ids.conge, days: "0" })))).toMatch(/propre demande/);
    expect(Number((await prisma.leaveRequest.findUnique({ where: { id: ids.conge } }))?.days)).toBe(5);
    expect(Number((await prisma.employee.findUnique({ where: { id: employeId } }))?.leaveBalanceDays)).toBe(30);
  });

  it("demande de congé au guichet RH : refusée", async () => {
    expect(erreur(await decideHrLeave(form({ id: ids.demande, decision: "APPROVE" })))).toMatch(/propre demande/);
    expect((await prisma.hrDocumentRequest.findUnique({ where: { id: ids.demande } }))?.status).toBe("PENDING");
  });

  it("note de frais : refusée", async () => {
    expect(erreur(await decideExpenseReport(form({ id: ids.frais, decision: "APPROVE" })))).toMatch(/propre demande/);
    expect((await prisma.hrDocumentRequest.findUnique({ where: { id: ids.frais } }))?.status).toBe("PENDING");
  });
});
