import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { refusAdministration } from "@/lib/admin/garde-comptes";
import { adminResetPassword, saveAccessMatrix, setUserActive, revokeSession, updateUserProfile } from "@/lib/actions/access-actions";
import { createUser, updateUserRole, setSecondaryRole } from "@/lib/actions/admin-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SEUL UN SUPER ADMIN FAIT — OU TOUCHE — UN SUPER ADMIN (§118.184 — audit 360°, S9).
 * Joué avec un administrateur DÉLÉGUÉ réel : un compte ordinaire à qui la console donne le module
 * Administration — le cas exact que l'audit a mesuré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("la règle pure", () => {
  const delegue = { id: "d", role: "VIEWER" };
  it("le Super Admin n'est jamais refusé", () => {
    expect(refusAdministration({ id: "s", role: "SUPER_ADMIN" }, { id: "s2", role: "SUPER_ADMIN" }, "ROLE", "SUPER_ADMIN")).toBeNull();
  });
  it("un délégué ne nomme pas de Super Admin, ne touche pas au compte d'un Super Admin, ne modifie pas ses propres droits", () => {
    expect(refusAdministration(delegue, { id: "t", role: "VIEWER" }, "ROLE", "SUPER_ADMIN")).toMatch(/nommer un Super Admin/);
    expect(refusAdministration(delegue, { id: "s", role: "SUPER_ADMIN" }, "COMPTE")).toMatch(/compte d'un Super Admin/);
    expect(refusAdministration(delegue, { id: "d", role: "VIEWER" }, "DROITS")).toMatch(/propres droits/);
  });
  it("les gestes ordinaires de la délégation restent possibles — le témoin sans lequel la garde passerait pour juste", () => {
    expect(refusAdministration(delegue, { id: "t", role: "VIEWER" }, "ROLE", "MEDICAL_DELEGATE")).toBeNull();
    expect(refusAdministration(delegue, { id: "t", role: "VIEWER" }, "COMPTE")).toBeNull();
    // Corriger son propre nom n'est pas modifier ses droits.
    expect(refusAdministration(delegue, { id: "d", role: "VIEWER" }, "COMPTE")).toBeNull();
  });
});

const TAG = "__gardadm__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("les vraies actions d'administration", () => {
  const u: Record<string, string> = {};
  let delegue: SessionUser, superAdmin: SessionUser;
  let sessionSa = "";

  async function nettoyer() {
    await prisma.userSession.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of [["sa", "SUPER_ADMIN"], ["deleg", "VIEWER"], ["cible", "VIEWER"]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    await prisma.userAccess.create({ data: { userId: u.deleg, module: "ADMIN", canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
    delegue = { id: u.deleg, role: "VIEWER", secondaryRole: null, access: await getAccess(u.deleg, "VIEWER") } as unknown as SessionUser;
    superAdmin = { id: u.sa, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.sa, "SUPER_ADMIN") } as unknown as SessionUser;
    sessionSa = (await prisma.userSession.create({ data: { userId: u.sa, expiresAt: new Date(Date.now() + 86_400_000) } })).id;
  });
  afterAll(async () => { await nettoyer(); });

  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const role = async (k: string) => (await prisma.user.findUniqueOrThrow({ where: { id: u[k] }, select: { role: true } })).role;

  it("PRÉMISSE : le délégué gère bien les comptes (Administration › modifier)", () => {
    expect(delegue.access.modules.get("ADMIN")?.actions.has("UPDATE")).toBe(true);
  });

  it("nommer un Super Admin — par deux écrans, et à la création — est refusé au délégué", async () => {
    ACTEUR = delegue;
    expect((await updateUserRole(fd({ id: u.cible, role: "SUPER_ADMIN" }))).ok).toBe(false);
    expect((await updateUserProfile(fd({ userId: u.cible, role: "SUPER_ADMIN" }))).ok).toBe(false);
    expect((await createUser(undefined, fd({ email: `${TAG}nouveau@t.dz`, name: "x", password: "motdepasse1", role: "SUPER_ADMIN" }))).ok).toBe(false);
    expect(await role("cible")).toBe("VIEWER");
    expect(await prisma.user.count({ where: { email: `${TAG}nouveau@t.dz` } })).toBe(0);
  });

  it("se nommer soi-même, ou s'accorder des modules, est refusé au délégué", async () => {
    ACTEUR = delegue;
    expect((await updateUserRole(fd({ id: u.deleg, role: "DIRECTION" }))).ok).toBe(false);
    expect((await setSecondaryRole(fd({ id: u.deleg, secondaryRole: "DIRECTION" }))).ok).toBe(false);
    expect((await saveAccessMatrix(fd({ userId: u.deleg, mode_FINANCES: "CUSTOM" }))).ok).toBe(false);
    expect(await role("deleg")).toBe("VIEWER");
  });

  it("toucher au compte d'un Super Admin — mot de passe, activation, session — est refusé au délégué", async () => {
    ACTEUR = delegue;
    expect((await adminResetPassword(fd({ userId: u.sa, password: "nouveaumdp1" }))).ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.sa }, select: { passwordHash: true } })).passwordHash).toBe("x");
    expect((await setUserActive(fd({ userId: u.sa, active: "false" }))).ok).toBe(false);
    expect((await revokeSession(fd({ sessionId: sessionSa }))).ok).toBe(false);
    expect((await prisma.userSession.findUniqueOrThrow({ where: { id: sessionSa } })).revokedAt).toBeNull();
  });

  it("les gestes ordinaires de la délégation passent ; le Super Admin, lui, nomme un Super Admin", async () => {
    ACTEUR = delegue;
    expect((await updateUserRole(fd({ id: u.cible, role: "MEDICAL_DELEGATE" }))).ok).toBe(true);
    expect((await adminResetPassword(fd({ userId: u.cible, password: "nouveaumdp1" }))).ok).toBe(true);
    ACTEUR = superAdmin;
    expect((await updateUserRole(fd({ id: u.cible, role: "SUPER_ADMIN" }))).ok).toBe(true);
    expect(await role("cible")).toBe("SUPER_ADMIN");
  });
});
