import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createEmployee, updateEmployee, setEmployeeActive } from "@/lib/actions/hr-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PERSONNE PARTIE NE GARDE PAS L'ERP — et la RH n'écrit que dans sa société
 * (§118.184 — audit 360°, S13).
 *
 * Mesuré par l'audit : désactiver une fiche salarié laissait son compte ouvert, sessions comprises. Et,
 * trouvé en écrivant ce banc : les écritures RH ne lisaient que le droit de module — la RH d'une société
 * modifiait et désactivait, par l'identifiant, un salarié d'une autre, dont la fiche lui est fermée.
 * Joué avec une RH rattachée à UNE société, sans vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__depart__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("la fiche salarié et le compte applicatif", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const e: Record<string, string> = {};
  let rhA: SessionUser;
  let session = "";

  async function nettoyer() {
    await prisma.userSession.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const mk = async (k: string, role: string, companyId: string) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" } })).id;
      e[k] = (await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: u[k] } })).id;
    };
    await mk("rh", "VIEWER", A);
    await mk("partant", "VIEWER", A);
    await mk("sa", "SUPER_ADMIN", A);
    await mk("autre", "VIEWER", B);
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: u.rh, module, canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
    rhA = { id: u.rh, role: "VIEWER", secondaryRole: null, access: await getAccess(u.rh, "VIEWER") } as unknown as SessionUser;
    session = (await prisma.userSession.create({ data: { userId: u.partant, expiresAt: new Date(Date.now() + 86_400_000) } })).id;
    ACTEUR = rhA;
  });

  afterAll(async () => { await nettoyer(); });

  // Le formulaire réel porte toute la fiche ; le banc envoie ce dont la règle a besoin — dont le compte lié,
  // sans quoi l'action le délierait (champ absent = effacé, par conception de cette action).
  const fiche = (k: string, companyId: string, actif: boolean) => {
    const f = new FormData();
    f.set("id", e[k]); f.set("fullName", `${TAG}${k}`); f.set("companyId", companyId); f.set("userId", u[k]);
    if (actif) f.set("isActive", "on");
    return f;
  };
  const compteActif = async (k: string) => (await prisma.user.findUniqueOrThrow({ where: { id: u[k] }, select: { isActive: true } })).isActive;

  it("PRÉMISSE : la RH gère le module, sans vue globale", () => {
    expect(rhA.access.modules.get("RH")?.actions.has("UPDATE")).toBe(true);
  });

  it("DÉSACTIVER la fiche ferme le compte et déconnecte ses sessions — et l'écran le dit", async () => {
    const r = await updateEmployee(fiche("partant", A, false));
    expect(r.ok).toBe(true);
    expect((r as { message?: string }).message).toMatch(/fermé et ses sessions déconnectées/);
    expect(await compteActif("partant")).toBe(false);
    expect((await prisma.userSession.findUniqueOrThrow({ where: { id: session } })).revokedAt).not.toBeNull();
  });

  it("RÉACTIVER la fiche ne rouvre pas le compte : c'est une décision d'administration, et l'écran le dit", async () => {
    const r = await updateEmployee(fiche("partant", A, true));
    expect(r.ok).toBe(true);
    expect((r as { message?: string }).message).toMatch(/reste désactivé/);
    expect(await compteActif("partant")).toBe(false);
  });

  it("LA FICHE D'UN SUPER ADMIN se désactive ; son compte, non — seul un Super Admin le ferme", async () => {
    const f = new FormData(); f.set("id", e.sa); f.set("isActive", "false");
    const r = await setEmployeeActive(f);
    expect(r.ok).toBe(true);
    expect((r as { message?: string }).message).toMatch(/Super Admin/);
    expect(await compteActif("sa")).toBe(true);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.sa } })).isActive).toBe(false);
  });

  it("ON NE SE FERME PAS SOI-MÊME par sa propre fiche", async () => {
    const r = await updateEmployee(fiche("rh", A, false));
    expect(r.ok).toBe(true);
    expect(await compteActif("rh")).toBe(true);
  });

  it("LA SOCIÉTÉ : la RH d'Alpha ne modifie ni ne désactive un salarié de Beta, et n'en range pas un chez Beta", async () => {
    expect(await updateEmployee(fiche("autre", B, false))).toEqual({ ok: false, error: "Employé introuvable." });
    const f = new FormData(); f.set("id", e.autre); f.set("isActive", "false");
    expect(await setEmployeeActive(f)).toEqual({ ok: false, error: "Employé introuvable." });
    expect(await compteActif("autre")).toBe(true);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.autre } })).isActive).toBe(true);
    const c = new FormData(); c.set("fullName", `${TAG}nouveau`); c.set("companyId", B);
    expect(await createEmployee(undefined, c)).toEqual({ ok: false, error: "Cette entité ne vous est pas ouverte." });
    // Ni déplacer un salarié d'Alpha chez Beta.
    expect(await updateEmployee(fiche("partant", B, true))).toEqual({ ok: false, error: "Cette entité ne vous est pas ouverte." });
  });

  it("POINT D'APPEL : le formulaire de fiche montre le refus et la conséquence, au lieu d'« Enregistré » quoi qu'il arrive", () => {
    const form = readFileSync("src/app/(app)/rh/[id]/employee-form.tsx", "utf8");
    expect(form).toMatch(/const r = await updateEmployee\(fd\);/);
    expect(form).toMatch(/if \(!r\.ok\) \{\s*setRetour\(\{ ok: false/);
    expect(form).toMatch(/if \(r\.message\) setRetour/);
  });
});
