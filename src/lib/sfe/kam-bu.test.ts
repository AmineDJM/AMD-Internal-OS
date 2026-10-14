import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { clausePanelDuKam, getAccess, type SessionUser } from "@/lib/rbac";
import { createSector, saveRepProfile, deleteRepProfile } from "@/lib/actions/sales-planning-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN KAM NE GARDE QUE LES SECTEURS DE SA BU (§118.184 — audit 360°, S15).
 *
 * Mesuré par l'audit : retiré de sa BU, ou passé dans une autre, un KAM gardait ses affectations aux
 * secteurs de l'ancienne — et leurs praticiens dans son panel : fiches ouvertes et modifiables, visites
 * planifiables. Deux corrections, et le banc tient les deux : le geste qui change la BU retire les
 * affectations, et la règle du panel ne compte que les secteurs de la BU où le KAM est rattaché — pour
 * qu'une ligne restée en base par un chemin qu'on n'a pas vu n'ouvre rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__kambu__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("le panel suit la BU du KAM", () => {
  let bu1 = "", bu2 = "", secteur = "", etab = "", praticien = "";
  const u: Record<string, string> = {};

  async function nettoyer() {
    await prisma.salesSector.deleteMany({ where: { businessUnit: { name: { startsWith: TAG } } } }).catch(() => {});
    // `SalesRepProfile.repId` n'a pas de relation déclarée : on retire par les identifiants des comptes du banc.
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of [["dir", "DIRECTION"], ["kam", "MEDICAL_DELEGATE"], ["oublie", "MEDICAL_DELEGATE"], ["retire", "MEDICAL_DELEGATE"], ["etranger", "MEDICAL_DELEGATE"]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    bu1 = (await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie` } })).id;
    bu2 = (await prisma.businessUnit.create({ data: { name: `${TAG}Cardiologie` } })).id;
    etab = (await prisma.medicalInstitution.create({ data: { name: `${TAG}CHU`, type: "CHU", wilaya: "Alger" } })).id;
    praticien = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr A`, institutionId: etab } })).id;
    await prisma.salesRepProfile.createMany({
      data: [
        { repId: u.kam, businessUnitId: bu1 },
        { repId: u.retire, businessUnitId: bu1 },
        // Celui-ci est passé en cardiologie par un chemin qui n'a pas nettoyé ses secteurs.
        { repId: u.oublie, businessUnitId: bu2 },
      ],
    });
    secteur = (await prisma.salesSector.create({
      data: {
        name: `${TAG}Est`, businessUnitId: bu1,
        institutions: { create: [{ institutionId: etab, tousLesServices: true }] },
        reps: { create: [{ repId: u.kam }, { repId: u.retire }, { repId: u.oublie }] },
      },
    })).id;
    ACTEUR = { id: u.dir, role: "DIRECTION", secondaryRole: null, access: await getAccess(u.dir, "DIRECTION") } as unknown as SessionUser;
  });

  afterAll(async () => { await nettoyer(); });

  const fd = (o: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
    return f;
  };
  const voit = async (k: string) =>
    (await prisma.medicalDoctor.count({ where: { AND: [{ id: praticien }, clausePanelDuKam(u[k])] } })) === 1;
  const affecte = async (k: string) => (await prisma.salesSectorRep.count({ where: { sectorId: secteur, repId: u[k] } })) === 1;

  it("le témoin : le KAM de la BU voit le praticien de son secteur", async () => {
    expect(await voit("kam")).toBe(true);
  });

  it("LA RÈGLE DE LECTURE : une affectation restée en base pour un KAM d'une autre BU n'ouvre rien", async () => {
    expect(await affecte("oublie")).toBe(true);
    expect(await voit("oublie")).toBe(false);
  });

  it("CHANGER LA BU d'un KAM lui retire les secteurs de l'ancienne — et l'écran le dit", async () => {
    const r = await saveRepProfile(fd({ repId: u.kam, businessUnitId: bu2 }));
    expect(r.ok).toBe(true);
    expect((r as { message?: string }).message).toMatch(/1 affectation\(s\) à un secteur de son ancienne BU/);
    expect(await affecte("kam")).toBe(false);
    expect(await voit("kam")).toBe(false);
  });

  it("RETIRER un KAM de la force de vente retire ses affectations", async () => {
    expect((await deleteRepProfile(fd({ repId: u.retire }))).ok).toBe(true);
    expect(await affecte("retire")).toBe(false);
  });

  it("AFFECTER à un secteur un compte qui n'est pas KAM de la BU est refusé, et rien n'est écrit", async () => {
    const r = await createSector(fd({ businessUnitId: bu1, name: `${TAG}Ouest`, repIds: [u.etranger] }));
    expect(r.ok).toBe(false);
    expect((r as { error?: string }).error).toMatch(/ne sont pas \(ou plus\) rattachés à cette BU/);
    expect(await prisma.salesSector.count({ where: { name: `${TAG}Ouest` } })).toBe(0);
  });
});
