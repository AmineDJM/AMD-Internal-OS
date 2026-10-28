import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SOCIÉTÉ VOISINE NE S'ÉCRIT PAS PAR IDENTIFIANT (audit 27/10/2026, SA-13 et SA-16).
 *
 *   SA-13 — événements : inscrire, changer le statut, retirer un participant, supprimer l'événement
 *           n'exigeaient que le droit du module ; `updateEvent` lisait déjà la porte de la fiche.
 *   SA-16 — rapports terrain : un manager (« lire le module » suffisait) réécrivait, validait ou rouvrait
 *           le rapport d'une autre société ; dossiers Legal et Courrier : la création vérifiait l'entité,
 *           la modification et la suppression non.
 *
 * Chaque acteur est cloisonné sur Alpha ; un témoin prouve qu'il agit sur Alpha — c'est la société de
 * l'OBJET qui le bloque, pas son droit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type Role } from "@/lib/rbac";
import { addRegistration, setRegistrationStatus, deleteRegistration, deleteEvent } from "@/lib/actions/event-actions";
import { validateFieldReport, updateFieldReport } from "@/lib/actions/field-report-actions";
import { updateLegalFolder, deleteLegalFolder } from "@/lib/actions/legal-folder-actions";
import { updateMailFolder, deleteMailFolder } from "@/lib/actions/mail-folder-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zportes${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ids = { A: "", B: "", ev: "", mgr: "", leg: "" };
const acteurs: Record<"ev" | "mgr" | "leg", CurrentUser | null> = { ev: null, mgr: null, leg: null };
const ROLES: Record<"ev" | "mgr" | "leg", Role> = { ev: "COORDINATOR", mgr: "MEDICAL_PROMOTION_MANAGER", leg: "COORDINATOR" };

suite("Écritures par identifiant : la société de l'objet", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const qui = ["ev", "mgr", "leg"] as const;
    const users = await Promise.all(qui.map((q) => prisma.user.create({ data: { name: `${TAG} ${q}`, email: `${TAG}${q}@t.dz`, role: ROLES[q], passwordHash: "x" } })));
    qui.forEach((q, i) => { ids[q] = users[i].id; });
    await Promise.all([
      ...qui.map((q) => prisma.employee.create({ data: { fullName: `${TAG} ${q}`, companyId: ids.A, userId: ids[q], isActive: true } })),
      prisma.userAccess.createMany({
        data: [
          { userId: ids.ev, module: "EVENTS", canView: true, canCreate: true, canUpdate: true, canDelete: true, canValidate: true, scope: "ALL" },
          { userId: ids.leg, module: "LEGAL", canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" },
          { userId: ids.leg, module: "MAIL_REGISTER", canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" },
        ],
      }),
    ]);
    const lus = await Promise.all(qui.map((q) => getAccess(ids[q], ROLES[q])));
    qui.forEach((q, i) => { acteurs[q] = { id: ids[q], name: `${TAG} ${q}`, email: `${TAG}${q}@t.dz`, role: ROLES[q], secondaryRole: null, access: lus[i] } as unknown as CurrentUser; });
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const comptes = [ids.ev, ids.mgr, ids.leg];
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { deletedById: { in: comptes } } }).catch(() => {});
    await prisma.fieldReport.deleteMany({ where: { summary: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalFolder.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => {});
  }, 60_000);

  it("SA-13 : les participants d'un événement de Beta ne s'écrivent pas ; l'événement ne se supprime pas", async () => {
    ACTEUR = acteurs.ev;
    const evB = await prisma.event.create({ data: { name: `${TAG} congrès Beta`, companyId: ids.B, registrations: { create: { firstName: "Amel", lastName: "B" } } }, include: { registrations: true } });
    const reg = evB.registrations[0].id;
    expect((await addRegistration(fd({ eventId: evB.id, firstName: "Intrus", lastName: "X" }))).ok).toBe(false);
    expect((await setRegistrationStatus(fd({ id: reg, status: "CANCELLED" }))).ok).toBe(false);
    expect((await deleteRegistration(fd({ id: reg }))).ok).toBe(false);
    expect((await deleteEvent(fd({ id: evB.id }))).ok).toBe(false);
    const apres = await prisma.event.findUnique({ where: { id: evB.id }, include: { registrations: true } });
    expect(apres?.registrations.map((r) => [r.firstName, r.status])).toEqual([["Amel", "REGISTERED"]]);
  });

  it("témoin SA-13 : sur un événement d'Alpha, le même acteur inscrit et retire", async () => {
    ACTEUR = acteurs.ev;
    const evA = await prisma.event.create({ data: { name: `${TAG} congrès Alpha`, companyId: ids.A } });
    const r = await addRegistration(fd({ eventId: evA.id, firstName: "Karim", lastName: "A" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const reg = await prisma.eventRegistration.findFirstOrThrow({ where: { eventId: evA.id } });
    expect((await deleteRegistration(fd({ id: reg.id }))).ok).toBe(true);
  });

  it("SA-16 : un manager d'Alpha ne réécrit ni ne valide un rapport terrain de Beta ; il valide celui d'Alpha", async () => {
    ACTEUR = acteurs.mgr;
    const [rB, rA] = await Promise.all([
      prisma.fieldReport.create({ data: { companyId: ids.B, summary: `${TAG} visite Beta`, status: "DRAFT" } }),
      prisma.fieldReport.create({ data: { companyId: ids.A, summary: `${TAG} visite Alpha`, status: "DRAFT" } }),
    ]);
    expect((await updateFieldReport(fd({ id: rB.id, summary: `${TAG} réécrit` }))).ok).toBe(false);
    expect((await validateFieldReport(fd({ id: rB.id }))).ok).toBe(false);
    const b = await prisma.fieldReport.findUniqueOrThrow({ where: { id: rB.id } });
    expect([b.summary, b.status]).toEqual([`${TAG} visite Beta`, "DRAFT"]);
    const ok = await validateFieldReport(fd({ id: rA.id }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
  });

  it("SA-16 : les dossiers Legal et Courrier de Beta ne se renomment ni ne se suppriment ; ceux d'Alpha, si", async () => {
    ACTEUR = acteurs.leg;
    const [lB, lA, mB, mA] = await Promise.all([
      prisma.legalFolder.create({ data: { name: `${TAG} contrats Beta`, companyId: ids.B } }),
      prisma.legalFolder.create({ data: { name: `${TAG} contrats Alpha`, companyId: ids.A } }),
      prisma.mailEntryFolder.create({ data: { name: `${TAG} plis Beta`, companyId: ids.B } }),
      prisma.mailEntryFolder.create({ data: { name: `${TAG} plis Alpha`, companyId: ids.A } }),
    ]);
    expect((await updateLegalFolder(fd({ id: lB.id, name: `${TAG} pris` }))).ok).toBe(false);
    expect((await deleteLegalFolder(fd({ id: lB.id }))).ok).toBe(false);
    expect((await updateMailFolder(fd({ id: mB.id, name: `${TAG} pris` }))).ok).toBe(false);
    expect((await deleteMailFolder(fd({ id: mB.id }))).ok).toBe(false);
    expect(await prisma.legalFolder.findUnique({ where: { id: lB.id }, select: { name: true } })).toEqual({ name: `${TAG} contrats Beta` });
    expect(await prisma.mailEntryFolder.findUnique({ where: { id: mB.id }, select: { name: true } })).toEqual({ name: `${TAG} plis Beta` });
    expect((await updateLegalFolder(fd({ id: lA.id, name: `${TAG} contrats Alpha 2026` }))).ok).toBe(true);
    expect((await deleteMailFolder(fd({ id: mA.id }))).ok).toBe(true);
  });
});
