import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { decideTraining } from "./training-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI SIGNE UNE FORMATION — la marche du N+1 et la marche « DG » (§118.185 — audit 360°, I12).
 *
 * Deux impasses mesurées par l'audit. (1) La marche « DG » ne s'ouvrait qu'à la VUE GLOBALE, qui
 * exclut délibérément le Directeur Général : le rôle qui porte le nom de l'étape ne pouvait pas la
 * signer. (2) La page ne comptait comme N+1 que la personne inscrite sur la fiche (`managerId`),
 * quand l'action — et l'organigramme — reconnaissent aussi le CHEF DU DÉPARTEMENT d'un salarié
 * sans responsable désigné : la page cachait un bouton que l'action aurait accepté.
 *
 * Joué par la vraie action, avec des acteurs sans vue globale, et la page tenue à son point
 * d'appel : elle doit lire LA MÊME chaîne et LE MÊME sommet que l'action.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__formsign${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

suite("qui signe une formation : le chef de département, le Directeur Général", () => {
  const users: Record<string, string> = {};
  const emps: Record<string, string> = {};
  let dept = "";

  const seed = async (cle: string, role: SessionUser["role"], departmentId: string | null = null) => {
    const u = await prisma.user.create({ data: { name: `${TAG} ${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const e = await prisma.employee.create({ data: { fullName: `${TAG} ${cle}`, userId: u.id, isActive: true, departmentId }, select: { id: true } });
    users[cle] = u.id; emps[cle] = e.id;
  };

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__formsign" } }, select: { id: true } })).map((u) => u.id);
    await prisma.training.deleteMany({ where: { title: { startsWith: "__formsign" } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: "__formsign" } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    await seed("chef", "MEDICAL_PROMOTION_MANAGER");
    dept = (await prisma.department.create({ data: { name: `${TAG} département`, code: `${TAG}D`, headId: emps.chef }, select: { id: true } })).id;
    await prisma.employee.update({ where: { id: emps.chef }, data: { departmentId: dept } });
    // Le demandeur : dans le département, SANS responsable désigné sur sa fiche.
    await seed("demandeur", "SALES_USER", dept);
    await seed("dg", "GENERAL_MANAGER");
    await seed("etranger", "SALES_USER");
  }, 120_000);
  afterAll(nettoyer, 120_000);

  const formation = (stage: "MANAGER" | "HR" | "DG") =>
    prisma.training.create({
      data: { title: `${TAG} formation ${stage}`, reference: `${TAG}-${stage}-${Math.random().toString(36).slice(2, 8)}`, requesterId: users.demandeur, stage, status: "PENDING", amount: 50_000 },
      select: { id: true },
    });
  const lire = (id: string) => prisma.training.findUniqueOrThrow({ where: { id }, select: { stage: true, status: true, managerDecidedById: true, dgDecidedById: true } });

  it("LE CHEF DU DÉPARTEMENT signe la marche du N+1 d'un salarié sans responsable désigné", async () => {
    const t = await formation("MANAGER");
    ACTOR = await actorFor(users.chef, "MEDICAL_PROMOTION_MANAGER");
    const r = await decideTraining(fd({ id: t.id, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const apres = await lire(t.id);
    expect(apres.managerDecidedById).toBe(users.chef);
    expect(apres.stage).not.toBe("MANAGER");
  });

  it("…et quelqu'un hors de la ligne hiérarchique est refusé, en disant qui l'on attend", async () => {
    const t = await formation("MANAGER");
    ACTOR = await actorFor(users.etranger, "SALES_USER");
    const r = await decideTraining(fd({ id: t.id, decision: "APPROVED" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/responsable hiérarchique/);
    expect((await lire(t.id)).stage).toBe("MANAGER");
  });

  it("LE DIRECTEUR GÉNÉRAL signe la marche « DG » — le rôle qui porte le nom de l'étape", async () => {
    const t = await formation("DG");
    ACTOR = await actorFor(users.dg, "GENERAL_MANAGER");
    const r = await decideTraining(fd({ id: t.id, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const apres = await lire(t.id);
    expect(apres.dgDecidedById).toBe(users.dg);
    expect(apres.status).toBe("APPROVED");
  });

  it("…et le chef du département, lui, n'y a pas la main", async () => {
    const t = await formation("DG");
    ACTOR = await actorFor(users.chef, "MEDICAL_PROMOTION_MANAGER");
    const r = await decideTraining(fd({ id: t.id, decision: "APPROVED" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/direction générale/);
  });

  it("LA PAGE lit la même chaîne et le même sommet que l'action (point d'appel)", () => {
    const src = readFileSync("src/app/(app)/formations/page.tsx", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // La chaîne : l'organigramme réel, chef de département compris — pas la seule fiche.
    expect(src).toMatch(/managementChainOf\(/);
    expect(src).toMatch(/loadReportingLine\(\)/);
    // Le sommet : la direction générale, DG compris — pas la vue globale.
    expect(src).toMatch(/const sommet = isTopManagement\(user\);/);
    expect(src).toMatch(/canDecideChain\([\s\S]{0,400}isDg: sommet/);
    // Et l'action lit le même sommet.
    const action = readFileSync("src/lib/actions/training-actions.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(action).toMatch(/const isDg = isTopManagement\(user\);/);
    expect(action).toMatch(/getManagementChain\(emp\.id\)/);
  });
});
