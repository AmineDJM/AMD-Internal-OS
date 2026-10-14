import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { adminResetPassword } from "./access-actions";

/**
 * Réinitialisation admin du mot de passe (bug rapporté : « ça ne change vraiment plus
 * le mot de passe »). Deux garanties :
 *  1. La connexion résout le compte par e-mail INSENSIBLE à la casse (findFirst … asc),
 *     mais la contrainte `@unique` est SENSIBLE à la casse → des variantes peuvent
 *     coexister. La réinitialisation doit s'appliquer à TOUTES ces lignes, sinon la
 *     connexion authentifie parfois une autre ligne avec l'ANCIEN mot de passe.
 *  2. Un compte VERROUILLÉ (anti-bruteforce) doit pouvoir se reconnecter aussitôt avec
 *     le nouveau mot de passe → le verrou est levé par la réinitialisation.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pwtest__${Date.now()}__`;
const OLD_HASH = bcrypt.hashSync("ancienMDP", 10);

function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

suite("adminResetPassword — change vraiment le mot de passe", () => {
  let adminId = "", olderId = "", newerId = "";
  const emailOlder = `${TAG}Dup@t.dz`; // créé en PREMIER (variante avec majuscule)
  const emailNewer = `${TAG}dup@t.dz`; // même e-mail, casse différente, créé APRÈS

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    adminId = admin.id;
    // Ordre de création = ordre chronologique : la connexion (orderBy createdAt asc)
    // authentifierait la ligne « Dup » (la plus ancienne).
    const older = await prisma.user.create({ data: { name: `${TAG}older`, email: emailOlder, role: "SALES_USER", passwordHash: OLD_HASH } });
    olderId = older.id;
    const newer = await prisma.user.create({ data: { name: `${TAG}newer`, email: emailNewer, role: "SALES_USER", passwordHash: OLD_HASH } });
    newerId = newer.id;
    ACTOR = { id: adminId, name: "admin", email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", access: await getAccess(adminId, "SUPER_ADMIN"), mustChangePassword: false };
  });

  afterAll(async () => {
    await prisma.loginAttempt.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
    await prisma.userSession.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("réinitialiser via la ligne récente met à jour AUSSI la ligne que la connexion authentifie", async () => {
    const r = await adminResetPassword(fd({ userId: newerId, password: "nouveauMDP123", mustChange: "on" }));
    expect(r.ok).toBe(true);

    // La ligne ANCIENNE (celle que la connexion résout) doit porter le NOUVEAU mot de passe.
    const older = await prisma.user.findUniqueOrThrow({ where: { id: olderId } });
    expect(await bcrypt.compare("nouveauMDP123", older.passwordHash)).toBe(true);
    expect(await bcrypt.compare("ancienMDP", older.passwordHash)).toBe(false);
    // La ligne ciblée aussi, évidemment.
    const newer = await prisma.user.findUniqueOrThrow({ where: { id: newerId } });
    expect(await bcrypt.compare("nouveauMDP123", newer.passwordHash)).toBe(true);
    expect(newer.mustChangePassword).toBe(true);
  });

  it("lève le verrouillage anti-bruteforce en cours (reconnexion immédiate possible)", async () => {
    await prisma.loginAttempt.create({
      data: { email: emailNewer.toLowerCase(), failures: 5, lockedUntil: new Date(Date.now() + 3_600_000), lastAttempt: new Date() },
    });
    const r = await adminResetPassword(fd({ userId: olderId, password: "encoreUnMDP456" }));
    expect(r.ok).toBe(true);
    const lock = await prisma.loginAttempt.findUnique({ where: { email: emailNewer.toLowerCase() } });
    expect(lock).toBeNull();
  });

  it("refuse un mot de passe trop court (< 8) et ne touche à rien", async () => {
    const r = await adminResetPassword(fd({ userId: newerId, password: "court" }));
    expect(r.ok).toBe(false);
  });
});
