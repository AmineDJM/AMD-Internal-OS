import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * « ORIGINAUX REÇUS » PASSE AUX RH (Super Admin, 24/11/2026) — les notes de frais ne relèvent pas de l'assistante de
 * direction : l'accusé de réception des originaux se fait dans la file des demandes RH. Par la vraie action, base réelle :
 *   • l'assistante de direction (sans le droit « Modifier » des demandes RH) est refusée — le remède dit où cela se fait ;
 *   • le Super Admin l'accuse ; un second accusé est refusé, et l'employé n'est prévenu qu'une fois.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { ackExpenseOriginals } from "@/modules/rh/actions-documents";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zorig${Date.now()}`;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const role = u.role as SessionUser["role"];
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false } as CurrentUser;
}

suite("Note de frais — « Originaux reçus » se fait aux RH", () => {
  const ids = { sa: "", ast: "", salarie: "", employe: "", frais: "" };

  beforeAll(async () => {
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, passwordHash: "x", role } })).id;
    ids.sa = await mk("sa", "SUPER_ADMIN");
    ids.ast = await mk("ast", "DIRECTION_ASSISTANT");
    ids.salarie = await mk("sal", "MEDICAL_DELEGATE");
    ids.employe = (await prisma.employee.create({ data: { fullName: `${TAG} salarié`, baseSalary: 1, userId: ids.salarie } })).id;
    ids.frais = (await prisma.hrDocumentRequest.create({ data: { employeeId: ids.employe, type: "EXPENSE_REPORT", expenseMonth: "2026-10" } })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    await prisma.hrDocumentRequest.deleteMany({ where: { employeeId: ids.employe } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: ids.employe } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: [ids.sa, ids.ast, ids.salarie] } }, { link: { contains: ids.frais } }] } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.sa, ids.ast] } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  }, 60_000);

  it("l'assistante de direction n'accuse plus réception : la note ne relève pas d'elle", async () => {
    ACTOR = await acteur(ids.ast);
    expect(userCan(ACTOR, "HR_REQUESTS", "UPDATE"), "prémisse : pas le droit RH").toBe(false);
    const r = await ackExpenseOriginals(form({ id: ids.frais }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/RH/);
    expect((await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: ids.frais } })).originalsAckAt).toBeNull();
  });

  it("le Super Admin l'accuse ; un second accusé est refusé et ne prévient pas deux fois", async () => {
    ACTOR = await acteur(ids.sa);
    const [r1, r2] = await Promise.all([ackExpenseOriginals(form({ id: ids.frais })), ackExpenseOriginals(form({ id: ids.frais }))]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect((r1.ok ? r2 : r1).error).toMatch(/déjà/);
    const d = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: ids.frais } });
    expect(d.originalsAckAt).not.toBeNull();
    expect(d.originalsAckById).toBe(ids.sa);
    expect(await prisma.notification.count({ where: { userId: ids.salarie, title: "Originaux réceptionnés" } })).toBe(1);
  });
});
