import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { chargerAujourdhui } from "@/lib/queries/aujourdhui-espace";
import { relanceTaskRequest } from "@/lib/actions/task-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AUJOURD'HUI » — CHACUN NE VOIT QUE CE QUE SES DROITS LUI OUVRENT (Direction, 14/10/2026).
 *
 * Joué par le vrai point d'entrée de la page (`chargerAujourdhui`) sur la base locale, avec des acteurs
 * SANS vue globale (prémisse vérifiée) :
 *   · le responsable Finances voit l'ordre de dépense dans son lot « paiements à régler », avec son montant
 *     et son retard ; le délégué médical ne le voit nulle part (ni lot, ni ligne, ni raccourci « Paiements ») ;
 *   · le délégué voit sa tâche en retard dans SA file, et le geste qu'il a fait aujourd'hui dans « Ma semaine » ;
 *   · son N+1 voit l'encart « Mon équipe » : le délégué en retard, et la relance de la tâche qu'il lui a
 *     demandée — que l'action existante (`relanceTaskRequest`) accepte ; un tiers ne voit ni l'encart ni la relance.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PREFIXE = "__aujourdhui";
const TAG = `${PREFIXE}${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const ilYA = (jours: number) => new Date(Date.now() - jours * 86_400_000);

suite("« Aujourd'hui » — la file, la semaine et l'équipe, selon les droits", () => {
  const u: Record<string, string> = {};
  const emp: Record<string, string> = {};
  let ordreId = "";
  let tacheId = "";
  let companyId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    const fiches = (await prisma.employee.findMany({ where: { userId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    const taches = (await prisma.task.findMany({ where: { OR: [{ assignedToId: { in: comptes } }, { createdById: { in: comptes } }] }, select: { id: true } })).map((x) => x.id);
    await prisma.taskComment.deleteMany({ where: { taskId: { in: taches } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: { in: taches } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: fiches } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    companyId = (await prisma.company.create({ data: { name: `${TAG} société` } })).id;
    const roles: [string, SessionUser["role"]][] = [
      ["fin", "FINANCE_BUDGET_MANAGER"], ["del", "MEDICAL_DELEGATE"], ["mgr", "MEDICAL_PROMOTION_MANAGER"], ["tiers", "MEDICAL_DELEGATE"],
    ];
    for (const [k, role] of roles) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    emp.mgr = (await prisma.employee.create({ data: { fullName: `${TAG} mgr`, userId: u.mgr, companyId, isActive: true } })).id;
    emp.del = (await prisma.employee.create({ data: { fullName: `${TAG} del`, userId: u.del, companyId, isActive: true, managerId: emp.mgr } })).id;
    for (const k of ["fin", "tiers"]) {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId, isActive: true } })).id;
    }
    // Un ordre de dépense à régler, échu depuis 10 jours.
    ordreId = (await prisma.expenseOrder.create({
      data: { reference: `${TAG}OD`, label: `${TAG} honoraires`, amount: 123456, category: "EVENEMENT", status: "PENDING", dueDate: ilYA(10) },
    })).id;
    // Une tâche que le N+1 a DEMANDÉE au délégué, en retard de 3 jours.
    tacheId = (await prisma.task.create({
      data: { title: `${TAG} rapport`, assignedToId: u.del, createdById: u.mgr, status: "TODO", requestedAt: ilYA(8), dueDate: ilYA(3), createdAt: ilYA(8) },
    })).id;
    // Un geste fait aujourd'hui par le délégué : une tâche terminée.
    await prisma.task.create({ data: { title: `${TAG} fait`, assignedToId: u.del, createdById: u.del, status: "DONE", completedAt: new Date() } });
  }, 180_000);
  afterAll(nettoyer, 180_000);

  it("prémisse : aucun acteur n'a la vue globale", async () => {
    for (const k of ["fin", "del", "mgr", "tiers"]) expect(hasGlobalView((await actorFor(u[k])).role)).toBe(false);
  });

  it("le responsable Finances voit l'ordre dans son lot de paiements, montant et retard compris", async () => {
    const a = await actorFor(u.fin);
    const j = await chargerAujourdhui(a, { nom: a.name, employeeId: emp.fin });
    const lot = j.lots.find((l) => l.nature === "paiement");
    expect(lot, "un lot « paiements à régler »").toBeTruthy();
    const ligne = lot!.lignes.find((l) => l.key === `pay-${ordreId}`);
    expect(ligne).toMatchObject({ montant: 123456, retard: 10 });
    expect(lot!.geste.href).toContain(ordreId);
    expect(j.tuiles.map((t) => t.k)).toContain("Paiements en attente");
    expect(j.raccourcis.map((r) => r.href)).toContain("/finances/paiements-a-faire");
  });

  it("le délégué ne voit ni le lot de paiements, ni l'ordre, ni le raccourci — mais sa tâche et son geste du jour", async () => {
    const a = await actorFor(u.del);
    const j = await chargerAujourdhui(a, { nom: a.name, employeeId: emp.del, tachesOuvertes: 1, tachesRetard: 1 });
    expect(j.lots.some((l) => l.nature === "paiement")).toBe(false);
    expect(JSON.stringify(j.lots)).not.toContain(ordreId);
    expect(j.raccourcis.map((r) => r.href)).not.toContain("/finances/paiements-a-faire");
    const taches = j.lots.find((l) => l.nature === "tache");
    expect(taches?.lignes.find((l) => l.key === `task-${tacheId}`)?.retard).toBe(3);
    expect(j.semaine.fait).toBeGreaterThanOrEqual(1);
    expect(j.equipe, "un délégué sans équipe n'a pas d'encart").toBeNull();
  });

  it("le N+1 voit son délégué en retard et la relance ; l'action existante l'accepte", async () => {
    const a = await actorFor(u.mgr);
    const j = await chargerAujourdhui(a, { nom: a.name, employeeId: emp.mgr });
    expect(j.equipe?.directs).toBe(1);
    const m = j.equipe!.membres.find((x) => x.employeeId === emp.del);
    expect(m).toMatchObject({ enRetard: 1, relanceTacheId: tacheId });
    ACTOR = a;
    const fd = new FormData();
    fd.set("id", tacheId);
    expect((await relanceTaskRequest(fd)).ok).toBe(true);
    // Relancée à l'instant : le délai de courtoisie retire le bouton.
    const apres = await chargerAujourdhui(a, { nom: a.name, employeeId: emp.mgr });
    expect(apres.equipe!.membres.find((x) => x.employeeId === emp.del)?.relanceTacheId).toBeNull();
  });

  it("un tiers sans lien hiérarchique n'a ni l'encart ni la tâche des autres", async () => {
    const a = await actorFor(u.tiers);
    const j = await chargerAujourdhui(a, { nom: a.name, employeeId: emp.tiers });
    expect(j.equipe).toBeNull();
    expect(JSON.stringify(j.lots)).not.toContain(tacheId);
  });
});
