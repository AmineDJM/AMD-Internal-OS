import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { sitsOnPaymentCentre } from "./domaine/authorization";
import { grantPaymentCentreSeat, revokePaymentCentreSeat } from "./actions-sieges";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__seattest__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/**
 * LE SIÈGE NOMMÉ N'OUVRE PLUS RIEN (Super Admin, 24/11/2026 : « centre de paiement : AUCUN siège par pôle — réservé à la
 * Direction générale »). Sur les vraies actions et le vrai `getAccess` : la désignation est refusée avec son remède, un
 * siège accordé hier reste en base (on n'efface rien) mais ne fait plus siéger, et son retrait reste au Super Admin.
 */
suite("Siège nommé au centre de paiement — fermé, les sièges d'hier neutralisés", () => {
  let adminId = "", cibleId = "", pdgId = "", dgId = "";

  beforeAll(async () => {
    const mk = (suffix: string, role: SessionUser["role"], extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { name: `${TAG}${suffix}`, email: `${TAG}${suffix}@t.dz`, role, passwordHash: "x", ...extra } });
    const [admin, cible, pdg, dg] = await Promise.all([
      mk("admin", "SUPER_ADMIN"),
      mk("cible", "FINANCE_BUDGET_MANAGER"),
      mk("pdg", "DIRECTION"),
      mk("dg", "GENERAL_MANAGER"),
    ]);
    adminId = admin.id; cibleId = cible.id; pdgId = pdg.id; dgId = dg.id;
  });

  afterAll(async () => {
    await prisma.paymentCentreSeat.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("par le rôle : le Directeur Général siège, le PDG non — sur l'accès réellement résolu", async () => {
    const dg = await actorFor(dgId, "GENERAL_MANAGER");
    expect(sitsOnPaymentCentre(dg)).toBe(true);
    expect(dg.access.modules.get("PAYMENT_CENTRE")?.actions.has("VIEW")).toBe(true);
    const pdg = await actorFor(pdgId, "DIRECTION");
    expect(sitsOnPaymentCentre(pdg)).toBe(false);
    expect(pdg.access.modules.has("PAYMENT_CENTRE"), "l'entrée de menu ne s'ouvre plus au PDG").toBe(false);
  });

  it("DÉSIGNER est refusé, avec le remède — et rien n'est écrit", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: cibleId, note: "Autorise les paiements pendant l'absence du DG." }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/réservé à la Direction générale/);
    expect(r.error).toMatch(/rôle de Directeur Général/);
    expect(await prisma.paymentCentreSeat.count({ where: { userId: cibleId } })).toBe(0);
  });

  it("SEUL LE SUPER ADMIN touche aux sièges — un autre se voit refuser avant même la règle", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const r = await grantPaymentCentreSeat(form({ userId: cibleId, note: "Par le DG" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Super Admin/);
  });

  it("un siège accordé HIER reste en base, mais ne fait plus siéger ni n'ouvre le module", async () => {
    const avant = new Set((await actorFor(cibleId, "FINANCE_BUDGET_MANAGER")).access.modules.keys());
    await prisma.paymentCentreSeat.create({ data: { userId: cibleId, grantedById: adminId, note: "Intérim du PDG (avant le 24/11/2026)." } });
    const cible = await actorFor(cibleId, "FINANCE_BUDGET_MANAGER");
    expect(sitsOnPaymentCentre(cible)).toBe(false);
    expect([...cible.access.modules.keys()].filter((m) => !avant.has(m)), "aucun module de plus").toEqual([]);
    expect(await prisma.paymentCentreSeat.count({ where: { userId: cibleId } }), "rien n'est effacé").toBe(1);
  });

  it("le Super Admin peut retirer un siège d'hier ; l'intéressé (administrateur délégué) non (SA-18)", async () => {
    const acteur = await actorFor(cibleId, "FINANCE_BUDGET_MANAGER");
    acteur.access.modules.set("ADMIN", { actions: new Set(["VIEW", "UPDATE"]), scope: "ALL" });
    ACTOR = acteur;
    expect((await revokePaymentCentreSeat(form({ userId: cibleId }))).ok).toBe(false);
    expect(await prisma.paymentCentreSeat.count({ where: { userId: cibleId } })).toBe(1);

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    expect((await revokePaymentCentreSeat(form({ userId: cibleId }))).ok).toBe(true);
    expect(await prisma.paymentCentreSeat.count({ where: { userId: cibleId } })).toBe(0);
    const r = await revokePaymentCentreSeat(form({ userId: cibleId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pas de siège/i);
  });
});
