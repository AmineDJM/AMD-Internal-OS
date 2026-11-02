import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { createCongressRequest } from "./actions-congres";
import { addCareBeneficiary, decideCareBeneficiary, marquerPriseEnChargeRealisee, sendCareToFinance } from "./actions-prise-en-charge";
import { envoiAuxFinances } from "./infra/prise-en-charge/realisation";
import { peutMarquerRealisee } from "./domaine/prise-en-charge/fiches";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « RÉALISÉ » N'EST PLUS POSÉ PAR L'IMPORT SEUL (Direction, 27/10).
 *
 * `COMPLETED` n'avait aucun geste : seul l'import historique l'écrivait. « Marquer réalisée » le pose — le
 * demandeur ou la Direction Marketing, APRÈS l'envoi aux Finances, avec trace d'audit. Par les VRAIES actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pecrealisee__${Date.now()}`;

async function actorFor(id: string, role: UserRole): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access, mustChangePassword: false };
}
const fdOf = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

describe("peutMarquerRealisee — la règle pure", () => {
  it("le demandeur, la Direction Marketing (rôle principal ou secondaire), le Super Admin — personne d'autre", () => {
    expect(peutMarquerRealisee({ id: "a", roles: ["MEDICAL_DELEGATE"] }, { requesterId: "a" })).toBe(true);
    expect(peutMarquerRealisee({ id: "b", roles: ["COORDINATOR", "PRODUCT_MANAGER"] }, { requesterId: "a" })).toBe(true);
    expect(peutMarquerRealisee({ id: "c", roles: ["SUPER_ADMIN"] }, { requesterId: "a" })).toBe(true);
    expect(peutMarquerRealisee({ id: "d", roles: ["DIRECTION_ASSISTANT"] }, { requesterId: "a" })).toBe(false);
    expect(peutMarquerRealisee({ id: "d", roles: ["COORDINATOR"] }, { requesterId: null })).toBe(false);
  });
});

suite("Prise en charge — « Marquer réalisée » après l'envoi aux Finances", () => {
  let pmId = "", saId = "", horsId = "", natId = "";
  let PM: CurrentUser, SA: CurrentUser, HORS: CurrentUser;

  beforeAll(async () => {
    const mk = (n: string, role: UserRole) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [pm, sa, hors] = await Promise.all([mk("dm", "PRODUCT_MANAGER"), mk("sa", "SUPER_ADMIN"), mk("hors", "COORDINATOR")]);
    pmId = pm.id; saId = sa.id; horsId = hors.id;
    PM = await actorFor(pmId, "PRODUCT_MANAGER");
    SA = await actorFor(saId, "SUPER_ADMIN");
    HORS = await actorFor(horsId, "COORDINATOR");

    ACTOR = PM;
    const nat = await createCongressRequest(undefined, fdOf({ type: "NATIONAL", name: `${TAG}Nat`, date: "2026-11-10", endDate: "2026-11-11" }));
    expect(nat.ok, nat.ok ? "" : nat.error).toBe(true);
    natId = nat.ok ? nat.id! : "";
    const pers = await addCareBeneficiary(undefined, fdOf({ scope: "NATIONAL", requestId: natId, lastName: `${TAG}Orateur` }));
    expect(pers.ok, pers.ok ? "" : pers.error).toBe(true);
    ACTOR = SA;
    const dec = await decideCareBeneficiary(undefined, fdOf({ id: pers.id!, decision: "APPROVED" }));
    expect(dec.ok, dec.ok ? "" : dec.error).toBe(true);
    // Le dossier est COMPLET (tout est réglé) et la Direction a validé l'événement.
    await prisma.careCell.updateMany({ where: { beneficiary: { congressNationalId: natId } }, data: { status: "SETTLED" } });
    await prisma.congressNational.update({ where: { id: natId }, data: { requestStatus: "APPROVED" } });
  }, 60_000);

  afterAll(async () => {
    const sujets = (await prisma.congressNational.findMany({ where: { id: natId }, select: { careReservationDossierId: true } }).catch(() => []))
      .map((s) => s.careReservationDossierId).filter((v): v is string => Boolean(v));
    await prisma.careQuote.deleteMany({ where: { congressNationalId: natId } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: natId } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: { in: sujets } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { OR: [{ user: { email: { startsWith: TAG } } }, { body: { contains: TAG } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: [pmId, saId, horsId] } }, { entityId: natId }] } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("NON ENVOYÉE aux Finances : le demandeur est refusé, le statut ne bouge pas", async () => {
    expect(await envoiAuxFinances("NATIONAL", natId)).toBeNull();
    ACTOR = PM;
    const r = await marquerPriseEnChargeRealisee(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(r.ok === false && r.error).toMatch(/Transmettez d'abord le dossier aux Finances/);
    const d = await prisma.congressNational.findUniqueOrThrow({ where: { id: natId }, select: { requestStatus: true } });
    expect(d.requestStatus).toBe("APPROVED");
  });

  it("l'envoi aux Finances laisse sa trace relisible", async () => {
    ACTOR = SA;
    const r = await sendCareToFinance(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await envoiAuxFinances("NATIONAL", natId)).toBeInstanceOf(Date);
  });

  it("une personne étrangère au circuit est refusée, même après l'envoi", async () => {
    ACTOR = HORS;
    const r = await marquerPriseEnChargeRealisee(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(r.ok === false && r.error).toMatch(/demandeur ou la Direction Marketing/);
  });

  it("ENVOYÉE : le demandeur la marque réalisée → COMPLETED, avec trace d'audit ; un second clic est refusé", async () => {
    ACTOR = PM;
    const r = await marquerPriseEnChargeRealisee(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const d = await prisma.congressNational.findUniqueOrThrow({ where: { id: natId }, select: { requestStatus: true, status: true } });
    expect(d.requestStatus).toBe("COMPLETED");
    expect(d.status).toBe("COMPLETED");
    const trace = await prisma.auditLog.findFirst({ where: { entityId: natId, field: "requestStatus", newValue: "COMPLETED" }, select: { actorId: true, oldValue: true } });
    expect(trace).toEqual({ actorId: pmId, oldValue: "APPROVED" });

    const encore = await marquerPriseEnChargeRealisee(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(encore.ok === false && encore.error).toMatch(/déjà marquée réalisée/);
  });
});
