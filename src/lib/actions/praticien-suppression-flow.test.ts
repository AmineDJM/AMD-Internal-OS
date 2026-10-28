import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UN PRATICIEN N'EFFACE PLUS SON HISTOIRE (audit 27/10/2026, DONNEES-07).
 *
 * `deleteDoctor` effaçait TOUTES les visites du praticien puis la fiche ; la cascade du schéma emportait ses
 * montants Ad & Pro (`AdProMedecin.montant`), sa segmentation et ses observations — sans corbeille, y compris par
 * Adam. Désormais :
 *   - un praticien qui porte des visites rapportées ou des montants Ad & Pro attribués est REFUSÉ (→ l'archivage) ;
 *   - sinon, il part à la corbeille avec son lot et revient entier par la restauration.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { deleteDoctor } from "./medical-actions";
import { restoreDeletedRecord } from "./admin-delete-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zprat${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let saId = "";

suite("deleteDoctor — refus quand l'histoire compte, corbeille sinon", () => {
  beforeAll(async () => {
    saId = (await prisma.user.create({ data: { name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    ACTEUR = { id: saId, name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(saId, "SUPER_ADMIN") } as unknown as CurrentUser;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const docs = (await prisma.medicalDoctor.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    await prisma.medicalVisit.deleteMany({ where: { doctorId: { in: docs } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { deletedById: saId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: saId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: saId } }).catch(() => {});
  }, 60_000);

  it("visites rapportées ou montant Ad & Pro : refusé, rien n'est effacé", async () => {
    const [aVisite, aMontant] = await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG} Dr Visité`, visits: { create: { date: new Date(), status: "COMPLETED" } } } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG} Dr Orateur` } }),
    ]);
    await prisma.adProMedecin.create({ data: { entityType: "EVENT", entityId: `${TAG}-ev`, doctorId: aMontant.id, montant: 80_000, createdById: saId } });
    const r1 = await deleteDoctor(fd({ id: aVisite.id }));
    const r2 = await deleteDoctor(fd({ id: aMontant.id }));
    expect(r1.ok ? "" : r1.error).toMatch(/visite\(s\) rapportée\(s\).*Archivez-le/);
    expect(r2.ok ? "" : r2.error).toMatch(/montant\(s\) Ad & Pro/);
    expect(await prisma.medicalVisit.count({ where: { doctorId: aVisite.id } })).toBe(1);
    expect(await prisma.adProMedecin.count({ where: { doctorId: aMontant.id } })).toBe(1);
  });

  it("sans histoire : à la corbeille, puis restauré entier", async () => {
    const doublon = await prisma.medicalDoctor.create({ data: { name: `${TAG} Dr Doublon` } });
    const r = await deleteDoctor(fd({ id: doublon.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.medicalDoctor.count({ where: { id: doublon.id } })).toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DOCTOR", sourceId: doublon.id } });
    const back = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(back.ok, back.ok ? "" : back.error).toBe(true);
    expect(await prisma.medicalDoctor.count({ where: { id: doublon.id } })).toBe(1);
  });
});
