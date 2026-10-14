import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { sitsOnPaymentCentre } from "@/lib/payments/authorization";
import { grantPaymentCentreSeat, revokePaymentCentreSeat } from "./payment-centre-seat-actions";

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
 * LE SIÈGE NOMMÉ, DE BOUT EN BOUT — sur les vraies actions et le vrai `getAccess`.
 *
 * Ce que le module pur ne peut pas prouver : que la désignation ARRIVE jusqu'à la règle. C'est
 * précisément là que les deux gestes précédents échouaient en silence — cocher le module, poser un
 * rôle secondaire — et un test qui n'irait pas de l'action jusqu'à `sitsOnPaymentCentre` laisserait
 * exactement le même trou.
 */
suite("Siège nommé au centre de paiement", () => {
  let adminId = "", cibleId = "", pdgId = "";

  beforeAll(async () => {
    const mk = (suffix: string, role: SessionUser["role"], extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { name: `${TAG}${suffix}`, email: `${TAG}${suffix}@t.dz`, role, passwordHash: "x", ...extra } });
    const [admin, cible, pdg] = await Promise.all([
      mk("admin", "SUPER_ADMIN"),
      mk("cible", "FINANCE_BUDGET_MANAGER"),
      mk("pdg", "DIRECTION"),
    ]);
    adminId = admin.id; cibleId = cible.id; pdgId = pdg.id;
  });

  afterAll(async () => {
    await prisma.paymentCentreSeat.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("avant toute désignation, la personne ne siège pas", async () => {
    const cible = await actorFor(cibleId, "FINANCE_BUDGET_MANAGER");
    expect(sitsOnPaymentCentre(cible)).toBe(false);
  });

  it("le MOTIF est obligatoire — un siège sans raison est un siège que personne n'ose retirer", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: cibleId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/POURQUOI/);
  });

  it("désigné : il siège RÉELLEMENT, et le siège n'ajoute QUE le centre", async () => {
    // On photographie ses modules AVANT, pour que l'assertion porte sur la DIFFÉRENCE. Vérifier
    // « il n'a pas les RH » ne prouverait rien : son rôle lui en donne peut-être déjà, et le test
    // passerait ou tomberait pour une raison étrangère au siège.
    const avant = new Set((await actorFor(cibleId, "FINANCE_BUDGET_MANAGER")).access.modules.keys());

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: cibleId, note: "Autorise les paiements pendant l'absence du PDG." }));
    expect(r.ok).toBe(true);

    // LE CHEMIN COMPLET : action → base → getAccess → règle. C'est ici que les deux gestes
    // précédents (case du module, rôle secondaire) se cassaient sans le dire.
    const cible = await actorFor(cibleId, "FINANCE_BUDGET_MANAGER");
    expect(cible.access.paymentCentreSeat).toBe(true);
    expect(sitsOnPaymentCentre(cible)).toBe(true);
    // L'entrée de menu s'ouvre : un droit qu'on ne peut atteindre qu'en connaissant l'URL n'est
    // pas un droit accordé.
    expect(cible.access.modules.get("PAYMENT_CENTRE")?.actions.has("VIEW")).toBe(true);

    // LE SIÈGE N'EST PAS UNE PROMOTION : exactement un module de plus, et c'est celui-là.
    const ajoutes = [...cible.access.modules.keys()].filter((m) => !avant.has(m));
    expect(ajoutes).toEqual(["PAYMENT_CENTRE"]);

    // La personne est prévenue — un droit reçu sans le savoir n'est pas exercé.
    const notif = await prisma.notification.findFirst({ where: { userId: cibleId }, orderBy: { createdAt: "desc" } });
    expect(notif?.title).toMatch(/centre de paiement/i);
  });

  it("deux fois la même personne : refusé, et le refus le dit", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: cibleId, note: "Encore" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/siège déjà/i);
  });

  it("le PDG n'a pas besoin d'un siège nommé — et on refuse d'en créer un qui ne servirait à rien", async () => {
    // Un siège en double ferait croire, le jour où on le retire, qu'on a retiré l'accès.
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: pdgId, note: "Doublon" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/par son rôle/i);
  });

  it("SEUL LE SUPER ADMIN désigne — pas même le PDG, qui siège pourtant", async () => {
    // Administration reste souveraine et séparée : siéger au centre ne donne pas le droit
    // d'élargir le centre. Sans cette séparation, le cercle pourrait se coopter lui-même.
    ACTOR = await actorFor(pdgId, "DIRECTION");
    const r = await grantPaymentCentreSeat(form({ userId: cibleId, note: "Par le PDG" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Super Admin/);
  });

  it("retiré : il ne siège plus, et le module se referme", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await revokePaymentCentreSeat(form({ userId: cibleId }));
    expect(r.ok).toBe(true);
    const cible = await actorFor(cibleId, "FINANCE_BUDGET_MANAGER");
    expect(sitsOnPaymentCentre(cible)).toBe(false);
    expect(cible.access.modules.has("PAYMENT_CENTRE")).toBe(false);
  });

  it("retirer un siège qui n'existe pas se DIT, au lieu de faire semblant", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await revokePaymentCentreSeat(form({ userId: cibleId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pas de siège/i);
  });

  it("LE COMPTE SYSTÈME NE SIÈGE PAS — autoriser un décaissement est un geste de personne", async () => {
    // Sans ce refus, l'interdit d'auto-escalade de `policy/guard.ts` se contournerait par un
    // humain qui clique : Adam autoriserait alors les paiements qu'il a lui-même préparés.
    const systeme = await prisma.user.create({
      data: { name: `${TAG}systeme`, email: `${TAG}systeme@t.dz`, role: "VIEWER", passwordHash: "x", isSystem: true },
    });
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: systeme.id, note: "Pour Adam" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/compte système/i);
  });

  it("un compte DÉSACTIVÉ ne siège pas — le siège se réveillerait sans qu'on l'ait redécidé", async () => {
    const inactif = await prisma.user.create({
      data: { name: `${TAG}inactif`, email: `${TAG}inactif@t.dz`, role: "VIEWER", passwordHash: "x", isActive: false },
    });
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await grantPaymentCentreSeat(form({ userId: inactif.id, note: "Plus tard" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/désactivé/i);
  });
});
