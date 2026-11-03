import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * T3 (décision 0051) — LES SALLES ET LEURS RÉSERVATIONS, ET LA MISE À JOUR DES DOSSIERS EN LOT, RÉVERSIBLES : chaque action
 * EXÉCUTÉE au clic de l'écran (journal des effets, `annulable.gesteId`), puis ANNULÉE (le bouton « Annuler »), contre la
 * base locale. Le lot de dossiers s'annule d'UN geste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// Les salles sont mises de côté (Direction, 03/11/2026) : ce banc les rétablit le temps de prouver leur réversibilité.
vi.hoisted(() => { process.env.SALLES_EN_SERVICE = "1"; });
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { mettreAJourDossiersEnLot } from "@/lib/actions/dossier-actions";
import {
  annulerReservationMoyenGeneral, archiverMoyenGeneral, creerMoyenGeneral, modifierMoyenGeneral, reserverMoyenGeneral,
} from "@/modules/salles/actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zt3rev${Date.now().toString(36)}`;
let MG: CurrentUser;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string) => {
  const r = await annulerGeste(gesteId, MG);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};

suite("T3 — salles, réservations et dossiers en lot : exécuter, puis annuler", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Imene`, email: `${TAG}@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    for (const module of ["GENERAL_MEANS", "DOSSIERS"]) await prisma.userAccess.create({ data: { userId: u.id, module, canView: true, canCreate: true, canUpdate: true, scope: "ALL" as never } });
    MG = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    ACTOR = MG;
  });

  afterAll(async () => {
    ACTOR = null;
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: MG.id } }).catch(() => undefined);
    await prisma.moyenGeneral.deleteMany({ where: { libelle: { contains: TAG } } }).catch(() => undefined);
    await prisma.dossier.deleteMany({ where: { title: { contains: TAG } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: MG.id } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: MG.id } }).catch(() => undefined);
  });

  it("creerMoyenGeneral → annulé : la fiche disparaît", async () => {
    const r = await creerMoyenGeneral(undefined, fd({ type: "SALLE", libelle: `Salle Hoggar ${TAG}`, capacite: "6" }));
    expect(r.ok, r.error).toBe(true);
    await annuler(gesteDe(r));
    expect(await prisma.moyenGeneral.count({ where: { libelle: `Salle Hoggar ${TAG}` } })).toBe(0);
  });

  it("modifierMoyenGeneral puis archiverMoyenGeneral → annulés : valeurs et statut d'avant", async () => {
    const c = await creerMoyenGeneral(undefined, fd({ type: "SALLE", libelle: `Salle Djurdjura ${TAG}`, capacite: "10", notes: "écran" }));
    expect(c.ok, c.error).toBe(true);
    const m = await modifierMoyenGeneral(undefined, fd({ id: c.id!, capacite: "12", notes: "écran et visio" }));
    expect(m.ok, m.error).toBe(true);
    expect((await prisma.moyenGeneral.findUniqueOrThrow({ where: { id: c.id! } })).capacite).toBe(12);
    await annuler(gesteDe(m));
    const apres = await prisma.moyenGeneral.findUniqueOrThrow({ where: { id: c.id! } });
    expect(apres.capacite).toBe(10);
    expect(apres.notes).toBe("écran");
    const a = await archiverMoyenGeneral(fd({ id: c.id! }));
    expect(a.ok, a.error).toBe(true);
    await annuler(gesteDe(a));
    expect((await prisma.moyenGeneral.findUniqueOrThrow({ where: { id: c.id! } })).statut).toBe("ACTIF");
  });

  it("reserverMoyenGeneral → annulé : le créneau se libère ; annulerReservationMoyenGeneral → annulé : la réservation revient", async () => {
    const s = await creerMoyenGeneral(undefined, fd({ type: "SALLE", libelle: `Salle ${TAG}`, capacite: "10" }));
    expect(s.ok, s.error).toBe(true);
    const r = await reserverMoyenGeneral(undefined, fd({ moyenId: s.id!, debut: "2027-05-10T10:00", fin: "12:00", objet: "Comité" }));
    expect(r.ok, r.error).toBe(true);
    // Le même créneau ne se reprend pas.
    expect((await reserverMoyenGeneral(undefined, fd({ moyenId: s.id!, debut: "2027-05-10T11:00", fin: "12:30", objet: "Autre" }))).ok).toBe(false);
    await annuler(gesteDe(r));
    expect(await prisma.moyenGeneralReservation.count({ where: { moyenId: s.id! } })).toBe(0);
    const r2 = await reserverMoyenGeneral(undefined, fd({ moyenId: s.id!, debut: "2027-05-11T10:00", objet: "Point" }));
    expect(r2.ok, r2.error).toBe(true);
    const x = await annulerReservationMoyenGeneral(fd({ id: r2.id! }));
    expect(x.ok, x.error).toBe(true);
    expect((await prisma.moyenGeneralReservation.findUniqueOrThrow({ where: { id: r2.id! } })).statut).toBe("ANNULEE");
    await annuler(gesteDe(x));
    expect((await prisma.moyenGeneralReservation.findUniqueOrThrow({ where: { id: r2.id! } })).statut).toBe("CONFIRMEE");
  });

  it("mettreAJourDossiersEnLot → annulé : chaque dossier du lot revient, d'un geste", async () => {
    const ref = (n: number) => `DOS-2026-${TAG.slice(-4)}${n}`;
    const a = await prisma.dossier.create({ data: { reference: ref(1), title: `A ${TAG}`, status: "OPEN", createdById: MG.id } });
    const b = await prisma.dossier.create({ data: { reference: ref(2), title: `B ${TAG}`, status: "IN_PROGRESS", createdById: MG.id } });
    const lot = JSON.stringify([
      { id: a.id, avant: { status: "OPEN", dueDate: null, priority: "MEDIUM" }, status: "DONE", dueDate: "2026-12-15" },
      { id: b.id, avant: { status: "IN_PROGRESS", dueDate: null, priority: "MEDIUM" }, priority: "HIGH" },
    ]);
    const r = await mettreAJourDossiersEnLot(fd({ changements: lot }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("DONE");
    await annuler(gesteDe(r));
    const [a2, b2] = await Promise.all([prisma.dossier.findUniqueOrThrow({ where: { id: a.id } }), prisma.dossier.findUniqueOrThrow({ where: { id: b.id } })]);
    expect([a2.status, a2.dueDate, b2.priority]).toEqual(["OPEN", null, "MEDIUM"]);
  });
});
