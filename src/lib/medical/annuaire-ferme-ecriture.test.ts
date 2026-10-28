import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * UN ANNUAIRE FERMÉ NE SE RÈGLE PAS DE L'EXTÉRIEUR (audit sécurité 27/10, SECURITE-ACCES-08).
 * Qui n'est pas sur la liste d'un annuaire fermé ne peut ni lever la restriction (liste vide), ni s'y
 * ajouter, ni toucher à ses colonnes ou à son nom. Qui y est nommé le peut.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { setDirectoryAccess, createDirectoryColumn, updateMedicalDirectory } from "@/lib/actions/medical-directory-crud-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zannu${Date.now()}`;
const ids = { dehors: "", dedans: "", annuaire: "" };
const form = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
  return f;
};
const acteur = async (id: string): Promise<CurrentUser> =>
  ({ id, name: id, email: `${id}@t.dz`, role: "NATIONAL_SALES", secondaryRole: null, access: await getAccess(id, "NATIONAL_SALES") }) as unknown as CurrentUser;
const acces = async () => (await prisma.medicalDirectoryAccess.findMany({ where: { directoryId: ids.annuaire }, select: { userId: true } })).map((a) => a.userId);

suite("Annuaire fermé : les écritures suivent la règle de lecture", () => {
  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}dehors`, email: `${TAG}x@t.dz`, passwordHash: "x", role: "NATIONAL_SALES" } }),
      prisma.user.create({ data: { name: `${TAG}dedans`, email: `${TAG}y@t.dz`, passwordHash: "x", role: "NATIONAL_SALES" } }),
    ]);
    Object.assign(ids, { dehors: a.id, dedans: b.id });
    ids.annuaire = (await prisma.medicalDirectory.create({
      data: { name: `${TAG} Infectiologues`, access: { create: [{ userId: b.id }] } },
    })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.dehors, ids.dedans] } } }).catch(() => undefined);
    await prisma.medicalDirectory.deleteMany({ where: { id: ids.annuaire } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [ids.dehors, ids.dedans] } } }).catch(() => undefined);
  }, 60_000);

  it("témoin : le rôle a bien le droit « Modifier » du module", async () => {
    expect(userCan((await acteur(ids.dehors)) as unknown as SessionUser, "MEDICAL", "UPDATE")).toBe(true);
  });

  it("qui n'est pas nommé ne lève pas la restriction", async () => {
    ACTOR = await acteur(ids.dehors);
    expect((await setDirectoryAccess(form({ id: ids.annuaire }))).ok).toBe(false);
    expect(await acces()).toEqual([ids.dedans]);
  });

  it("qui n'est pas nommé ne s'ajoute pas, ne renomme pas, n'ajoute pas de colonne", async () => {
    ACTOR = await acteur(ids.dehors);
    expect((await setDirectoryAccess(form({ id: ids.annuaire, userId: [ids.dehors] }))).ok).toBe(false);
    expect((await updateMedicalDirectory(form({ id: ids.annuaire, name: "pris" }))).ok).toBe(false);
    expect((await createDirectoryColumn(form({ directoryId: ids.annuaire, label: "pris" }))).ok).toBe(false);
    expect(await acces()).toEqual([ids.dedans]);
  });

  it("qui est nommé règle l'accès", async () => {
    ACTOR = await acteur(ids.dedans);
    expect((await setDirectoryAccess(form({ id: ids.annuaire, userId: [ids.dedans, ids.dehors] }))).ok).toBe(true);
    expect((await acces()).sort()).toEqual([ids.dedans, ids.dehors].sort());
  });
});
