import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { completeOnboarding, saveOnboardingProfile } from "./onboarding-actions";
import { requestOnboarding } from "./access-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__onbtest__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Onboarding — demande (admin), complétion et profil (self-service)", () => {
  let adminId = "", userId = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [admin, user] = await Promise.all([mk("admin", "SUPER_ADMIN"), mk("user", "VIEWER")]);
    adminId = admin.id; userId = user.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le Super Admin déclenche l'onboarding (mustOnboard = true)", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("userId", userId);
    expect((await requestOnboarding(fd)).ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.mustOnboard).toBe(true);
    expect(u.onboardedAt).toBeNull();
  });

  it("un non-admin ne peut pas demander le setup d'un compte", async () => {
    ACTOR = await actorFor(userId, "VIEWER");
    const fd = new FormData(); fd.set("userId", adminId);
    expect((await requestOnboarding(fd)).ok).toBe(false);
  });

  it("le profil self-service met à jour, sans écraser avec des valeurs vides", async () => {
    ACTOR = await actorFor(userId, "VIEWER");
    const fd = new FormData(); fd.set("phone", "0550 11 22 33"); fd.set("title", "Testeur");
    expect((await saveOnboardingProfile(fd)).ok).toBe(true);
    let u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.phone).toBe("0550 11 22 33");
    expect(u.title).toBe("Testeur");

    // Soumission vide → on conserve les valeurs existantes (enrichit, n'efface pas).
    const empty = new FormData(); empty.set("phone", ""); empty.set("title", "");
    expect((await saveOnboardingProfile(empty)).ok).toBe(true);
    u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.phone).toBe("0550 11 22 33");
    expect(u.title).toBe("Testeur");
  });

  it("la complétion lève le drapeau et horodate (prend effet à chaud)", async () => {
    ACTOR = await actorFor(userId, "VIEWER");
    expect((await completeOnboarding()).ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.mustOnboard).toBe(false);
    expect(u.onboardedAt).not.toBeNull();
  });
});
