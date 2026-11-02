import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { modifierTache } from "@/lib/actions/task-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REPLANIFIER UNE TÂCHE (`modifierTache`, décision 0020) — le geste que l'Assistant IA faisait seul, revenu en action
 * d'écran. Joué sur la base locale, par l'action elle-même :
 *   · le créateur change l'échéance, la priorité et le responsable : la tâche suit, l'ancien et le nouveau
 *     responsable sont prévenus, l'audit garde le geste ;
 *   · un participant change l'échéance, mais pas le responsable ; un tiers ne touche à rien ;
 *   · une demande en attente ne se réattribue pas par ici ; une échéance illisible est refusée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PREFIXE = "__modif_tache";
const TAG = `${PREFIXE}${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const formulaire = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

suite("modifierTache — échéance, priorité, responsable", () => {
  const u: Record<string, string> = {};
  let tacheId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    await prisma.task.deleteMany({ where: { createdById: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const k of ["chef", "karim", "amel", "part", "tiers"]) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    }
    tacheId = (await prisma.task.create({
      data: { title: `${TAG} stand`, assignedToId: u.karim, createdById: u.chef, participantIds: [u.part, u.amel], status: "TODO", priority: "MEDIUM" },
    })).id;
  }, 120_000);
  afterAll(nettoyer, 120_000);

  it("le créateur replanifie et confie à une autre : la tâche suit, les deux responsables sont prévenus, l'audit garde le geste", async () => {
    ACTOR = await actorFor(u.chef);
    const r = await modifierTache(formulaire({ id: tacheId, dueDate: "2026-11-06", priority: "HIGH", assignedToId: u.amel }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const t = await prisma.task.findUniqueOrThrow({ where: { id: tacheId } });
    expect(t.dueDate?.toISOString().slice(0, 10)).toBe("2026-11-06");
    expect(t.priority).toBe("HIGH");
    expect(t.assignedToId).toBe(u.amel);
    expect(t.participantIds, "la nouvelle responsable n'est plus participante").not.toContain(u.amel);
    expect(await prisma.notification.count({ where: { userId: { in: [u.karim, u.amel] }, title: "Tâche modifiée" } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { actorId: u.chef, entityId: tacheId } })).toBe(1);
  });

  it("un participant change l'échéance (et peut la retirer), pas le responsable", async () => {
    ACTOR = await actorFor(u.part);
    const confier = await modifierTache(formulaire({ id: tacheId, assignedToId: u.part }));
    expect(confier.ok).toBe(false);
    const retirer = await modifierTache(formulaire({ id: tacheId, clearDueDate: "1" }));
    expect(retirer.ok).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tacheId } })).dueDate).toBeNull();
  });

  it("un tiers ne touche à rien ; une échéance illisible et une priorité inconnue sont refusées", async () => {
    ACTOR = await actorFor(u.tiers);
    expect((await modifierTache(formulaire({ id: tacheId, priority: "LOW" }))).ok).toBe(false);
    ACTOR = await actorFor(u.chef);
    expect((await modifierTache(formulaire({ id: tacheId, dueDate: "bientôt" }))).ok).toBe(false);
    expect((await modifierTache(formulaire({ id: tacheId, priority: "URGENTISSIME" }))).ok).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tacheId } })).priority).toBe("HIGH");
  });

  it("une demande en attente ne se réattribue pas par ici (son circuit : réattribuer la demande)", async () => {
    await prisma.task.update({ where: { id: tacheId }, data: { status: "REQUESTED" } });
    ACTOR = await actorFor(u.chef);
    const r = await modifierTache(formulaire({ id: tacheId, assignedToId: u.karim }));
    expect(r.ok).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tacheId } })).assignedToId).toBe(u.amel);
  });
});
