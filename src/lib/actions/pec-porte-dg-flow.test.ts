import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/** Le seuil du DG est un réglage global : le banc l'injecte dans son propre processus (§118.132). */
const SEUIL_DG = 1_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), adProDgThreshold: SEUIL_DG }) };
});

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { decideCareQuote, demanderBCPriseEnCharge, retenirDevisPriseEnCharge } from "./care-actions";
import { statuerSurLeTotal, totalDeLaDemande } from "@/lib/ad-pro/porte-dg";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LE DG VALIDE LE TOTAL, DEVIS DE PERSONNES COMPRIS (Direction, 27/10/2026).
 *
 * « Le DG valide le total — le devis total du stand, de la prise en charge… Aucun bon de commande si ça
 * dépasse le seuil. » Une prise en charge engage surtout par ses DEVIS de personnes (hôtel, billets) :
 * le total de la porte les compte dès qu'ils sont retenus ou acceptés, et accepter un devis ou demander
 * son BC est refusé porte fermée — par les VRAIES actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pecportedg__${Date.now().toString(36)}`;

async function actorFor(id: string, role: UserRole): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fdOf = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

suite("Prise en charge — la porte du DG sur le total, devis de personnes compris", () => {
  let dirId = "", gmId = "";
  let DIR: CurrentUser;
  let natId = "", envId = "", catId = "", devis = "";

  beforeAll(async () => {
    const [dir, gm] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}gm`, email: `${TAG}gm@t.dz`, role: "GENERAL_MANAGER", passwordHash: "x" } }),
    ]);
    dirId = dir.id; gmId = gm.id;
    DIR = await actorFor(dirId, "DIRECTION");
    // PRÉVALIDÉE (statut d'origine, sans instance) : seule la porte du DG peut encore refuser.
    natId = (await prisma.congressNational.create({ data: { name: `${TAG}Nat`, requestStatus: "APPROVED", requesterId: dirId }, select: { id: true } })).id;
    const personne = (await prisma.careBeneficiary.create({ data: { congressNationalId: natId, firstName: "Amel", lastName: `${TAG}Accordée`, status: "APPROVED" } })).id;
    const cellule = (await prisma.careCell.create({ data: { beneficiaryId: personne, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Oran" } })).id;
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["CONGRESS_NATIONAL"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000 },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Congrès`, module: "CONGRESS_NATIONAL", allocated: 5_000_000 } })).id;
    devis = (await prisma.careQuote.create({
      data: { congressNationalId: natId, supplier: `${TAG}Hôtel`, amountDzd: 1_200_000, amount: 1_200_000, currency: "DZD", cells: { create: [{ cellId: cellule }] } },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: natId }, select: { id: true } }).catch(() => []);
    await prisma.careCell.updateMany({ where: { beneficiary: { congressNationalId: natId } }, data: { expenseOrderId: null, quoteId: null } }).catch(() => {});
    await prisma.careQuote.deleteMany({ where: { congressNationalId: natId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: natId } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: natId } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: natId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [dirId, gmId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [dirId, gmId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("un devis seulement REÇU ne compte pas dans le total — plusieurs se concurrencent pour les mêmes cases", async () => {
    expect(await totalDeLaDemande("CONGRESS_NATIONAL", natId)).toBe(0);
  });

  it("accepter un devis qui porterait le total au-dessus du seuil → refusé, aucun ordre", async () => {
    ACTOR = DIR;
    const r = await decideCareQuote(undefined, fdOf({ id: devis, decision: "ACCEPTED", budgetCategoryId: catId }));
    expect(r.ok === false && r.error).toMatch(/validation du Directeur Général est requise/);
    expect((await prisma.careQuote.findUniqueOrThrow({ where: { id: devis } })).status).toBe("PENDING");
    expect(await prisma.expenseOrder.count({ where: { sourceId: natId } })).toBe(0);
  });

  it("RETENU, le devis entre dans le total, le DG est prévenu ; son BC est refusé porte fermée", async () => {
    ACTOR = DIR;
    const ret = await retenirDevisPriseEnCharge(undefined, fdOf({ id: devis }));
    expect(ret.ok, ret.ok ? "" : ret.error).toBe(true);
    expect(await totalDeLaDemande("CONGRESS_NATIONAL", natId)).toBe(1_200_000);
    expect(await prisma.notification.count({ where: { userId: gmId, title: "Ad & Pro — total à valider (Directeur Général)", link: { contains: natId } } })).toBe(1);
    const r = await demanderBCPriseEnCharge(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(r.ok === false && r.error).toMatch(/Aucun bon de commande, engagement ni paiement/);
    expect((await prisma.careQuote.findUniqueOrThrow({ where: { id: devis } })).bcRequestedAt).toBeNull();
  });

  it("le DG valide le total → le devis s'accepte et son ordre de dépense part, catégorie comprise", async () => {
    const v = await statuerSurLeTotal({
      user: { id: gmId, name: `${TAG}gm`, role: "GENERAL_MANAGER" }, parent: "CONGRESS_NATIONAL", parentId: natId,
      decision: "VALIDEE", totalVu: 1_200_000, note: null,
    });
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    ACTOR = DIR;
    const r = await decideCareQuote(undefined, fdOf({ id: devis, decision: "ACCEPTED", budgetCategoryId: catId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const q = await prisma.careQuote.findUniqueOrThrow({ where: { id: devis }, select: { status: true, expenseOrderId: true } });
    expect(q.status).toBe("ACCEPTED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: q.expenseOrderId! } })).budgetCategoryId).toBe(catId);
  });
});
