import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * LE TRAITEMENT D'UNE DEMANDE RH SUIT LE PÉRIMÈTRE DE LA FILE ET LE GRAPHE DES STATUTS (audit sécurité 11/2026).
 *
 * `processHrRequest` ne vérifiait que le droit `HR_REQUESTS:UPDATE` : une RH d'Alpha posait n'importe quel statut sur
 * la demande d'un salarié de Beta ; une demande remise se rouvrait ; un congé passait « Prête » sans « Accorder ».
 * Désormais : même clause que la file « Demandes RH » (hors périmètre → « introuvable »), graphe de statuts pur,
 * écriture conditionnée au statut lu — deux clics n'écrivent qu'une fois.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import {
  processHrRequest, decideHrLeave, deleteHrRequest, addHrRequestComment, askHrRequestPiece, setExpenseClaimEditUnlocked,
} from "@/modules/rh/actions-documents";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zdemrhperim${Date.now()}`;
const ids = { A: "", B: "", rhA: "", rhB: "", salarieB: "", doc: "", conge: "", frais: "", annulee: "" };
const acteurs: Record<"A" | "B", CurrentUser | null> = { A: null, B: null };
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const statut = async (id: string) => (await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

async function rh(nom: string, companyId: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${nom}`, email: `${TAG}${nom}@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
  await prisma.employee.create({ data: { fullName: `${TAG} ${nom}`, companyId, userId: u.id, isActive: true } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "HR_REQUESTS", canView: true, canUpdate: true, scope: "ALL" } });
  return { id: u.id, name: u.name, email: u.email, role: "COORDINATOR", secondaryRole: null, access: await getAccess(u.id, "COORDINATOR") } as unknown as CurrentUser;
}

suite("Demandes RH — périmètre et graphe des statuts du traitement", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    [acteurs.A, acteurs.B] = await Promise.all([rh("rha", ids.A), rh("rhb", ids.B)]);
    ids.rhA = acteurs.A!.id; ids.rhB = acteurs.B!.id;
    const salarie = await prisma.user.create({ data: { name: `${TAG} salarie`, email: `${TAG}salarie@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
    ids.salarieB = (await prisma.employee.create({ data: { fullName: `${TAG} salarié B`, companyId: ids.B, userId: salarie.id, isActive: true } })).id;
    const [doc, conge, frais, annulee] = await Promise.all([
      prisma.hrDocumentRequest.create({ data: { employeeId: ids.salarieB, type: "WORK_CERTIFICATE" } }),
      prisma.hrDocumentRequest.create({ data: { employeeId: ids.salarieB, type: "ANNUAL_LEAVE", periodStart: new Date("2026-12-01"), periodEnd: new Date("2026-12-05"), periodDays: 5 } }),
      prisma.hrDocumentRequest.create({ data: { employeeId: ids.salarieB, type: "EXPENSE_REPORT", expenseMonth: "2026-11", expenseAmount: 1000 } }),
      prisma.hrDocumentRequest.create({ data: { employeeId: ids.salarieB, type: "SALARY_STATEMENT", status: "CANCELLED" } }),
    ]);
    Object.assign(ids, { doc: doc.id, conge: conge.id, frais: frais.id, annulee: annulee.id });
  }, 60_000);

  afterAll(async () => {
    const users = [ids.rhA, ids.rhB];
    await prisma.hrDocumentRequest.deleteMany({ where: { employeeId: ids.salarieB } }).catch(() => undefined);
    await prisma.comment.deleteMany({ where: { authorId: { in: users } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => undefined);
  }, 60_000);

  it("témoin : les deux RH ont le droit du module", () => {
    expect(userCan(acteurs.A as unknown as SessionUser, "HR_REQUESTS", "UPDATE")).toBe(true);
    expect(userCan(acteurs.B as unknown as SessionUser, "HR_REQUESTS", "UPDATE")).toBe(true);
  });

  it("une RH d'une autre société : « introuvable » partout, rien n'est écrit", async () => {
    ACTOR = acteurs.A;
    const r = await processHrRequest(form({ id: ids.doc, status: "READY", hrNote: "piratée" }));
    expect(r).toEqual({ ok: false, error: "Demande introuvable." });
    expect((await decideHrLeave(form({ id: ids.conge, decision: "APPROVE" }))).ok).toBe(false);
    expect((await deleteHrRequest(form({ id: ids.doc }))).error).toBe("Demande introuvable.");
    expect((await addHrRequestComment(form({ requestId: ids.doc, body: "intrusion" }))).error).toBe("Demande introuvable.");
    expect((await askHrRequestPiece(form({ requestId: ids.doc, label: "x" }))).error).toBe("Demande introuvable.");
    expect((await setExpenseClaimEditUnlocked(form({ id: ids.frais, unlock: "1" }))).error).toBe("Demande introuvable.");
    const apres = await prisma.hrDocumentRequest.findMany({ where: { employeeId: ids.salarieB }, select: { status: true, hrNote: true, editUnlockedAt: true } });
    expect(apres).toHaveLength(4);
    expect(apres.every((d) => d.hrNote === null && d.editUnlockedAt === null)).toBe(true);
    expect(await statut(ids.doc)).toBe("PENDING");
    expect(await statut(ids.conge)).toBe("PENDING");
    expect(await prisma.comment.count({ where: { entityId: ids.doc } })).toBe(0);
  });

  it("transitions interdites : refus clair en français, état inchangé", async () => {
    ACTOR = acteurs.B;
    const remise = await processHrRequest(form({ id: ids.doc, status: "DELIVERED" }));
    expect(remise.ok).toBe(false);
    expect(remise.error).toMatch(/« Soumise » → « Remise » impossible/);
    expect((await processHrRequest(form({ id: ids.conge, status: "READY" }))).error).toMatch(/Accorder/);
    expect((await processHrRequest(form({ id: ids.frais, status: "READY" }))).error).toMatch(/originaux/);
    expect((await processHrRequest(form({ id: ids.annulee, status: "IN_PROGRESS" }))).error).toMatch(/annulé/);
    expect((await processHrRequest(form({ id: ids.doc, status: "BIDON" }))).error).toMatch(/Statut inconnu/);
    expect((await processHrRequest(form({ id: ids.doc, status: "APPROVED" }))).ok).toBe(false);
    expect(await statut(ids.doc)).toBe("PENDING");
    expect(await statut(ids.conge)).toBe("PENDING");
    expect(await statut(ids.frais)).toBe("PENDING");
    expect(await statut(ids.annulee)).toBe("CANCELLED");
  });

  it("les transitions permises passent ; un état final ne se rouvre pas", async () => {
    ACTOR = acteurs.B;
    expect(await processHrRequest(form({ id: ids.doc, status: "IN_PROGRESS" }))).toEqual({ ok: true });
    expect(await processHrRequest(form({ id: ids.doc, status: "READY", hrNote: "Signée" }))).toEqual({ ok: true });
    expect(await statut(ids.doc)).toBe("READY");
    expect((await processHrRequest(form({ id: ids.doc, status: "IN_PROGRESS" }))).ok).toBe(false);
  });

  it("double clic : une seule écriture, le second clic est refusé", async () => {
    ACTOR = acteurs.B;
    const [r1, r2] = await Promise.all([
      processHrRequest(form({ id: ids.doc, status: "DELIVERED", hrNote: "Remise en main propre" })),
      processHrRequest(form({ id: ids.doc, status: "DELIVERED", hrNote: "Remise en main propre" })),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(await statut(ids.doc)).toBe("DELIVERED");
    expect(await prisma.auditLog.count({ where: { entityId: ids.doc, field: "status", newValue: "DELIVERED" } })).toBe(1);
    // Troisième clic, après coup : rien à enregistrer, aucune nouvelle écriture.
    const r3 = await processHrRequest(form({ id: ids.doc, status: "DELIVERED", hrNote: "Remise en main propre" }));
    expect(r3.ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: ids.doc, field: "status" } })).toBe(3);
  });
});
