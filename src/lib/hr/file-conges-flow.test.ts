import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { decideLeave } from "@/lib/actions/hr-actions";
import { decideTraining } from "@/lib/actions/training-actions";
import { getLeavesToDecide } from "@/lib/queries/hr";
import { leaveDecider } from "@/lib/hr/leave-core";
import { clauseFileConges } from "@/lib/hr/file-conges";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE MONTRE CE QUE L'ACTION ACCEPTE ; UNE DÉCISION À LA FOIS (§118.196, lot E1 — audit 360°, M08 et N1).
 *
 * Deux défauts, joués par les vrais points d'entrée avec des acteurs SANS vue globale :
 *   • un salarié muté d'une équipe à l'autre : sa demande, adressée à l'ancien responsable, n'apparaissait
 *     nulle part chez le nouveau — que l'action accepte pourtant ;
 *   • deux accords finaux simultanés sur un congé débitaient le solde DEUX fois ; deux décisions croisées
 *     sur une formation s'appliquaient l'une après l'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__fileconges${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false };
}
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const jour = (decalage: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + decalage); return d; };

/**
 * DEUX GESTES LANCÉS ENSEMBLE, la ligne verrouillée par le banc : tous deux lisent la demande, puis attendent à
 * l'écriture ; la barrière attend qu'ils soient DEUX à attendre sur cette table, puis relâche (§118.164e).
 */
async function deuxEnsemble<T>(table: "LeaveRequest" | "Training", id: string, a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
  let ga!: Promise<T>, gb!: Promise<T>;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
    ga = a(); gb = b();
    ga.catch(() => undefined); gb.catch(() => undefined);
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ${`%"${table}"%`}`;
      if (n >= 2) break;
      if (Date.now() - debut > 30_000) throw new Error("les deux gestes n'ont pas atteint la barrière");
      await new Promise((r) => setTimeout(r, 25));
    }
  }, { timeout: 60_000 });
  return Promise.all([ga, gb]);
}

suite("la file des congés du N+1, et une décision à la fois", () => {
  const u: Record<string, string> = {};
  const emp: Record<string, string> = {};
  let conge = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__fileconges" } }, select: { id: true } })).map((x) => x.id);
    const fiches = (await prisma.employee.findMany({ where: { userId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    await prisma.training.deleteMany({ where: { requesterId: { in: comptes } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: fiches } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: fiches } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const companyId = (await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } }))!.id;
    const roles = [["a", "HEAD_OF_SALES"], ["b", "HEAD_OF_REGULATORY"], ["e", "SALES_USER"], ["w", "HEAD_OF_SALES"], ["n2", "OPERATIONS_DIRECTOR"], ["g", "GENERAL_MANAGER"]] as const;
    for (const [k, role] of roles) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId, isActive: true } })).id;
    }
    // B rapporte à N2 ; E rapporte d'abord à A — et c'est A que la demande enregistre à sa soumission.
    await prisma.employee.update({ where: { id: emp.b }, data: { managerId: emp.n2 } });
    await prisma.employee.update({ where: { id: emp.e }, data: { managerId: emp.a } });
    conge = (await prisma.leaveRequest.create({
      data: { employeeId: emp.e, managerId: emp.a, startDate: jour(10), endDate: jour(12), days: 3, status: "PENDING", stage: "MANAGER" },
    })).id;
    // LA MUTATION : E passe dans l'équipe de B. La demande, elle, nomme toujours A.
    await prisma.employee.update({ where: { id: emp.e }, data: { managerId: emp.b } });
  }, 120_000);
  afterAll(nettoyer, 120_000);

  const dansLaFile = async (k: string) => (await getLeavesToDecide(await actorFor(u[k]))).some((l) => l.id === conge);

  it("le NOUVEAU responsable voit la demande ; l'ancien aussi (l'action l'accepte) ; le témoin et le N+2 non", async () => {
    expect(await dansLaFile("b"), "le N+1 actuel").toBe(true);
    expect(await dansLaFile("a"), "le N+1 enregistré").toBe(true);
    expect(await dansLaFile("w"), "un responsable d'une autre équipe").toBe(false);
    expect(await dansLaFile("e"), "on ne tranche pas son propre congé").toBe(false);
    // Le N+2 : l'action l'accepte (toute la chaîne au-dessus), la file ne le sollicite pas — le premier rang seulement.
    expect(await dansLaFile("n2")).toBe(false);
    expect((await leaveDecider(await actorFor(u.n2), { managerId: emp.a, employeeId: emp.e })).isManager).toBe(true);
    // La file ne lit plus toute la base avant de filtrer : sans responsabilité, pas de requête.
    expect(clauseFileConges({ isDg: false, isHr: false, fichesSignataires: [], salariesRattaches: [] })).toBeNull();
  }, 60_000);

  it("le nouveau responsable tranche depuis sa file — et la demande quitte la file des deux", async () => {
    ACTOR = await actorFor(u.b);
    const r = await decideLeave(form({ id: conge, decision: "APPROVED" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: conge } })).stage).toBe("HR");
    expect(await dansLaFile("b")).toBe(false);
    expect(await dansLaFile("a")).toBe(false);
  }, 60_000);

  it("DEUX ACCORDS FINAUX EN MÊME TEMPS : un seul passe, et le solde n'est débité qu'UNE fois", async () => {
    const avant = Number((await prisma.employee.findUniqueOrThrow({ where: { id: emp.e } })).leaveBalanceDays);
    const final = (await prisma.leaveRequest.create({
      data: { employeeId: emp.e, managerId: emp.b, startDate: jour(20), endDate: jour(24), days: 5, status: "PENDING", stage: "DG" },
    })).id;
    ACTOR = await actorFor(u.g);
    const [r1, r2] = await deuxEnsemble("LeaveRequest", final,
      () => decideLeave(form({ id: final, decision: "APPROVED" })),
      () => decideLeave(form({ id: final, decision: "APPROVED" })));
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    expect([r1, r2].find((r) => !r.ok)?.error).toBe("Cette demande vient d'être tranchée par quelqu'un d'autre — rechargez la page.");
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: emp.e } })).leaveBalanceDays)).toBe(avant - 5);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: final } })).status).toBe("APPROVED");
  }, 90_000);

  it("FORMATION : un accord et un refus croisés — un seul s'écrit, l'autre est dit", async () => {
    const formation = (await prisma.training.create({
      data: { reference: `${TAG}-FORM`, title: `${TAG} Formation BPF`, requesterId: u.e, status: "PENDING", stage: "DG", amount: 50_000 },
    })).id;
    ACTOR = await actorFor(u.g);
    const [r1, r2] = await deuxEnsemble("Training", formation,
      () => decideTraining(form({ id: formation, decision: "APPROVED" })),
      () => decideTraining(form({ id: formation, decision: "REJECTED", note: "Budget formation épuisé." })));
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const perdant = [r1, r2].find((r) => !r.ok);
    expect(perdant?.ok === false ? perdant.error : "").toBe("Cette demande vient d'être tranchée par quelqu'un d'autre — rechargez la page.");
    const t = await prisma.training.findUniqueOrThrow({ where: { id: formation } });
    expect(t.status === "APPROVED" ? r1.ok : r2.ok, "l'état écrit est celui du gagnant").toBe(true);
  }, 90_000);
});
