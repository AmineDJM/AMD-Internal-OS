import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SOCIÉTÉ VOISINE NE S'ÉCRIT PAS PAR IDENTIFIANT (audit 27/10/2026, SA-13).
 *
 *   SA-13 — événements : inscrire, changer le statut, retirer un participant, supprimer l'événement
 *           n'exigeaient que le droit du module ; `updateEvent` lisait déjà la porte de la fiche.
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
});
