import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LA SESSION SUIT LE COMPTE EN BASE, PAS LE JWT (audit sécurité 27/10, SECURITE-ACCES-07).
 *
 *   • Un compte DÉSACTIVÉ sans révocation de ses sessions (c'est ce que fait `toggleUserActive`, l'opération
 *     d'Adam) restait connecté jusqu'à 30 jours : `build()` ne relisait que la session.
 *   • Un Super Admin RÉTROGRADÉ gardait la « Vue exacte » : `startImpersonation` et `build()` lisaient le
 *     rôle figé dans le JWT au login — il continuait de lire l'OS comme n'importe quel compte actif.
 *   • Le compte système (Adam) ne se visualise pas.
 * Sur la base réelle ; seuls le JWT et les cookies sont simulés.
 */

const ETAT = vi.hoisted(() => ({ session: null as unknown, vue: undefined as string | undefined }));
vi.mock("@/auth", () => ({ auth: async () => ETAT.session }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (n: string) => (n === "amd_impersonate" && ETAT.vue ? { value: ETAT.vue } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: () => new Headers(),
}));

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { startImpersonation } from "@/lib/actions/impersonation-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zvivant${Date.now()}`;
const ids = { admin: "", cible: "", systeme: "", sid: "" };
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("Session : compte actif et rôle relus en base", () => {
  beforeAll(async () => {
    const [a, c, s] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG}cible`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
      prisma.user.create({ data: { name: `${TAG}sys`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN", isSystem: true } }),
    ]);
    Object.assign(ids, { admin: a.id, cible: c.id, systeme: s.id });
    ids.sid = (await prisma.userSession.create({ data: { userId: a.id, expiresAt: new Date(Date.now() + 86_400_000) } })).id;
  }, 60_000);

  beforeEach(async () => {
    // Le JWT dit TOUJOURS « Super Admin » : c'est ce qu'il a figé au login.
    ETAT.session = { user: { id: ids.admin, role: "SUPER_ADMIN", name: "Admin", email: `${TAG}a@t.dz`, sid: ids.sid } };
    ETAT.vue = undefined;
    await prisma.user.update({ where: { id: ids.admin }, data: { role: "SUPER_ADMIN", isActive: true } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.admin] } } }).catch(() => undefined);
    await prisma.userSession.deleteMany({ where: { userId: ids.admin } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.cible, ids.systeme] } } }).catch(() => undefined);
  }, 60_000);

  it("témoin : un Super Admin actif voit la personne visualisée", async () => {
    ETAT.vue = ids.cible;
    expect((await getCurrentUser())?.id).toBe(ids.cible);
  });

  it("compte désactivé sans révocation : plus de session", async () => {
    await prisma.user.update({ where: { id: ids.admin }, data: { isActive: false } });
    expect(await getCurrentUser()).toBeNull();
  });

  it("Super Admin rétrogradé : le cookie de vue est sans effet", async () => {
    await prisma.user.update({ where: { id: ids.admin }, data: { role: "VIEWER" } });
    ETAT.vue = ids.cible;
    const u = await getCurrentUser();
    expect(u?.id).toBe(ids.admin);
    expect(u?.role).toBe("VIEWER");
  });

  it("Super Admin rétrogradé : ne démarre pas la vue", async () => {
    await prisma.user.update({ where: { id: ids.admin }, data: { role: "VIEWER" } });
    expect((await startImpersonation(form({ userId: ids.cible }))).ok).toBe(false);
  });

  it("le compte système ne se visualise pas", async () => {
    const r = await startImpersonation(form({ userId: ids.systeme }));
    expect(r.ok).toBe(false);
  });
});
