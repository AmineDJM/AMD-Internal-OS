import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createSponsoring } from "@/modules/ad-pro/actions-sponsoring";
import { advanceWorkflow, faireAppelAdPro } from "@/lib/actions/workflow-actions";
import { ensureInstance } from "@/lib/workflow/engine";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE NATIONAL SALES D'UNE AUTRE GAMME NE TRANCHE PAS (audit 27/10/2026, ADPRO-06).
 *
 *   - `advanceWorkflow` n'avait pas la porte de la fiche : un congrès national (portée « ses lignes »)
 *     se tranchait par son identifiant sans pouvoir s'ouvrir ;
 *   - l'étape préliminaire nommait le RÔLE : sur un sponsoring (que tout National Sales voit), le
 *     National Sales de la gamme B approuvait la demande d'un KAM de la gamme A, à la place de son N+1.
 * Joué par les vraies portes : deux gammes, chacune supervisée par son National Sales.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__etgamme${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

function formulaire(institution: string): FormData {
  const f = fd({ institution, city: "Alger", specialty: "Cardiologie", type: "Congrès", amountRequested: "120000", amountProposed: "90000", nature: "DIRECT", strategicImportance: "HIGH" });
  f.append("doctorIds", `${TAG}Dr Benali`);
  f.append("productIds", `${TAG}Nivolex`);
  f.append("files", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "demande.pdf", { type: "application/pdf" }));
  return f;
}

suite("ADPRO-06 — l'étape du National Sales et la porte de la fiche", () => {
  const ids: Record<string, string> = {};
  let spoId = "", congresId = "", betaId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const spos = (await prisma.sponsoringRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true } })).map((s) => s.id);
    const congres = (await prisma.congressNational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const instances = (await prisma.workflowInstance.findMany({ where: { entityId: { in: [...spos, ...congres] } }, select: { id: true } })).map((i) => i.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: instances } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: instances } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: spos } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: spos } } }).catch(() => {});
    for (const id of [...spos, ...congres]) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: congres } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: comptes } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    const c = await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } });
    // Le National Sales de la gamme B est salarié d'une AUTRE société : la porte de la fiche le sépare du
    // congrès. Celui de la gamme C est de la MÊME société et voit tout le sponsoring (portée ALL) : seule
    // l'étape liée à la gamme le sépare de la demande du KAM de la gamme A.
    betaId = (await prisma.company.create({ data: { name: `${TAG}Beta` } })).id;
    for (const [cle, role] of [["kam", "MEDICAL_DELEGATE"], ["nsA", "NATIONAL_SALES"], ["nsB", "NATIONAL_SALES"], ["nsC", "NATIONAL_SALES"]] as const) {
      const u = await prisma.user.create({ data: { name: `${TAG} ${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
      await prisma.employee.create({ data: { fullName: `${TAG} ${cle}`, userId: u.id, isActive: true, companyId: cle === "nsB" ? betaId : c!.id } });
      ids[cle] = u.id;
    }
    const buA = await prisma.businessUnit.create({ data: { name: `${TAG} BU A`, supervisorId: ids.nsA }, select: { id: true } });
    await prisma.businessUnit.create({ data: { name: `${TAG} BU B`, supervisorId: ids.nsB } });
    await prisma.businessUnit.create({ data: { name: `${TAG} BU C`, supervisorId: ids.nsC } });
    await prisma.salesRepProfile.create({ data: { repId: ids.kam, businessUnitId: buA.id } });
    ACTOR = await actorFor(ids.kam, "MEDICAL_DELEGATE");
    const r = await createSponsoring(undefined, formulaire(`${TAG} Association cardio`));
    if (!r.ok) throw new Error(r.error);
    spoId = r.id!;
    congresId = (await prisma.congressNational.create({ data: { name: `${TAG} Journées de cardiologie`, requesterId: ids.kam, businessUnitId: buA.id, companyId: c!.id } })).id;
    expect((await ensureInstance("SPONSORING", spoId))?.currentSlug).toBe("preliminary");
  }, 120_000);
  afterAll(nettoyer, 120_000);

  it("le National Sales de la gamme C, même société, ne tranche pas le sponsoring d'un KAM de la gamme A", async () => {
    ACTOR = await actorFor(ids.nsC, "NATIONAL_SALES");
    const r = await advanceWorkflow(fd({ entityType: "SPONSORING", entityId: spoId, action: "APPROVE" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/habilité/);
    // Prévenu nommément, le superviseur ; les autres National Sales, plus du tout.
    const prevenus = (await prisma.notification.findMany({ where: { link: { contains: spoId }, userId: { in: [ids.nsA, ids.nsB, ids.nsC] } }, select: { userId: true } })).map((n) => n.userId);
    expect(prevenus).toContain(ids.nsA);
    expect(prevenus.filter((u) => u !== ids.nsA)).toEqual([]);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "SPONSORING", entityId: spoId } } })).currentSlug).toBe("preliminary");
  });

  it("un congrès d'une société qu'il ne voit pas est « introuvable » — avant le moteur, appel compris", async () => {
    ACTOR = await actorFor(ids.nsB, "NATIONAL_SALES");
    const r = await advanceWorkflow(fd({ entityType: "CONGRESS_NATIONAL", entityId: congresId, action: "REJECT", note: "non" }));
    expect(r.ok ? "" : r.error).toBe("Demande introuvable.");
    const a = await faireAppelAdPro(fd({ entityType: "CONGRESS_NATIONAL", entityId: congresId, motif: "x" }));
    expect(a.ok ? "" : a.error).toBe("Demande introuvable.");
    expect((await prisma.congressNational.findUniqueOrThrow({ where: { id: congresId } })).requestStatus).toBe("AWAITING_PRELIMINARY");
  });

  it("témoin : le National Sales de la gamme A, superviseur, approuve", async () => {
    ACTOR = await actorFor(ids.nsA, "NATIONAL_SALES");
    const r = await advanceWorkflow(fd({ entityType: "SPONSORING", entityId: spoId, action: "APPROVE" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "SPONSORING", entityId: spoId } } })).currentSlug).not.toBe("preliminary");
  });
});
