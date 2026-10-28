import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * LES ÉCRITURES DU DOSSIER RH SUIVENT LA PORTE DE LA FICHE (audit sécurité 27/10, SECURITE-ACCES-09).
 *
 * La fiche `/rh/[id]`, `updateEmployee` et la route de téléchargement refusent le salarié d'une société
 * qu'on ne voit pas (`entitePermisePourFiche`). Les pièces du dossier et la paie, non : une RH rattachée à
 * Alpha supprimait le contrat d'un salarié de Beta, le rendait visible, saisissait ou annulait sa paie.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { deleteEmployeeDocument, setEmployeeDocumentVisibility } from "@/lib/actions/hr-document-actions";
import { markSalaryPaid, unmarkSalaryPaid } from "@/lib/actions/payroll-hr-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zficherh${Date.now()}`;
const ids = { A: "", B: "", rh: "", salarieB: "", doc: "", paie: "" };
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("Dossier RH d'une autre société : aucune écriture", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const rh = await prisma.user.create({ data: { name: `${TAG} rh`, email: `${TAG}rh@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
    ids.rh = rh.id;
    await prisma.employee.create({ data: { fullName: `${TAG} rh`, companyId: ids.A, userId: rh.id, isActive: true } });
    await prisma.userAccess.createMany({ data: ["RH", "EMPLOYEES"].map((module) => ({ userId: rh.id, module, canView: true, canUpdate: true, scope: "ALL" as const })) });
    ACTOR = { id: rh.id, name: rh.name, email: rh.email, role: "COORDINATOR", secondaryRole: null, access: await getAccess(rh.id, "COORDINATOR") } as unknown as CurrentUser;
    ids.salarieB = (await prisma.employee.create({ data: { fullName: `${TAG} salarié B`, companyId: ids.B, isActive: true } })).id;
    const { blobId, size } = await putBlob(Buffer.from(`${TAG} contrat`));
    ids.doc = (await prisma.employeeDocument.create({ data: { employeeId: ids.salarieB, category: "CONTRACT", name: "contrat.pdf", blobId, mime: "application/pdf", size, visibleToEmployee: false } })).id;
    ids.paie = (await prisma.payrollEntry.create({ data: { employeeId: ids.salarieB, year: 2026, month: 9, gross: 1, net: 1, status: "PAID" } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: ids.rh } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { userId: ids.rh } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ids.rh } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => undefined);
  }, 60_000);

  it("témoin : la RH a bien les droits du module", () => {
    expect(userCan(ACTOR as unknown as SessionUser, "EMPLOYEES", "UPDATE")).toBe(true);
    expect(userCan(ACTOR as unknown as SessionUser, "RH", "UPDATE")).toBe(true);
  });

  it("pièce du dossier : ni rendue visible, ni supprimée", async () => {
    expect((await setEmployeeDocumentVisibility(form({ id: ids.doc, visible: "1" }))).ok).toBe(false);
    expect((await deleteEmployeeDocument(form({ id: ids.doc }))).ok).toBe(false);
    expect((await prisma.employeeDocument.findUnique({ where: { id: ids.doc } }))?.visibleToEmployee).toBe(false);
  });

  it("paie : ni saisie, ni annulée", async () => {
    expect((await markSalaryPaid(form({ employeeId: ids.salarieB, year: "2026", month: "10", employerCost: "100", net: "80" }))).ok).toBe(false);
    expect(await prisma.payrollEntry.count({ where: { employeeId: ids.salarieB, month: 10 } })).toBe(0);
    expect((await unmarkSalaryPaid(form({ id: ids.paie }))).ok).toBe(false);
    expect((await prisma.payrollEntry.findUnique({ where: { id: ids.paie } }))?.status).toBe("PAID");
  });
});
