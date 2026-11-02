import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createExpenseOrder, dossierHrefByOrder } from "@/modules/finances/api";
import { decidePaymentRequest, cancelPaymentRequest, nudgePaymentRequest } from "@/modules/finances/actions-demandes";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";
import { canDecideFromDossier } from "@/modules/finances/partage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__companion__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * UN ORDRE, UN DOSSIER — vérifié depuis LE VRAI POINT D'ENTRÉE (§118-14).
 *
 * Le module pur `finance/dossier-auto.ts` a ses propres tests : ils disent ce que la règle
 * DÉCIDE. Ce fichier-ci dit qu'elle est réellement APPLIQUÉE — que `createExpenseOrder`, la
 * fonction que treize circuits appellent, ouvre bien le dossier ; que le libellé de la file du
 * décaissement le trouve ; et que les gestes qui n'ont pas de sens sur un compagnon sont refusés
 * PAR LE SERVEUR, pas seulement masqués à l'écran (§118-7).
 *
 * On part d'un matériel promotionnel : c'est le cas exact du défaut constaté — un libellé qui ne
 * s'ouvrait pas dans « Paiements à faire ».
 */
suite("Un ordre de dépense, un dossier — quelle que soit sa provenance", () => {
  let requesterId = "", financeId = "", categorieId = "";
  const orders: string[] = [];

  beforeAll(async () => {
    const mk = (suffix: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${suffix}`, email: `${TAG}${suffix}@t.dz`, role, passwordHash: "x" } });
    const [req, fin] = await Promise.all([mk("req", "DIRECTION"), mk("fin", "FINANCE_BUDGET_MANAGER")]);
    requesterId = req.id; financeId = fin.id;
    // LE BUDGET DU BANC (§118.182) : une enveloppe à lui, qui ne couvre aucun module — donc invisible de
    // l'attribution automatique des autres bancs — et une catégorie où les Finances classent au règlement.
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG}enveloppe`, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
    });
    categorieId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}catégorie` } })).id;
  });

  afterAll(async () => {
    await prisma.financeTransaction.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: orders } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: orders } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { requesterId: { in: [requesterId, financeId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** Un ordre de matériel promotionnel, comme `promo-material-actions` en émet. */
  async function ordrePromo(label = `${TAG} matériel promotionnel`) {
    const order = await createExpenseOrder({
      label, amount: 90000, category: "FOURNISSEUR", beneficiary: "Agence Zed",
      sourceType: "PROMO_MATERIAL", sourceId: `pm-${Math.random().toString(36).slice(2)}`,
      requestedById: requesterId,
    });
    orders.push(order.id);
    return order;
  }

  it("UN MATÉRIEL PROMOTIONNEL OUVRE SON DOSSIER — c'est le libellé qui n'était pas cliquable", async () => {
    const order = await ordrePromo();
    const dossier = await prisma.paymentRequest.findFirst({ where: { expenseOrderId: order.id } });
    expect(dossier).not.toBeNull();
    expect(dossier!.origin).toBe("EXPENSE_ORDER");
    expect(dossier!.reference).toMatch(/^PAY-\d{4}-\d{3,}$/);
    // Il reprend l'ordre — et RATTACHE l'origine, qui reste ouvrable depuis le dossier.
    expect(dossier!.title).toContain("matériel promotionnel");
    expect(dossier!.payee).toBe("Agence Zed");
    expect(Number(dossier!.amount)).toBe(90000);
    expect(dossier!.entityType).toBe("PROMO_MATERIAL");
    expect(dossier!.requesterId).toBe(requesterId);
    // Le dossier part chez les Finances : le circuit d'origine avait déjà validé la dépense.
    expect(dossier!.status).toBe("SUBMITTED");
  });

  it("LE FIL NE S'OUVRE PAS VIDE — un historique blanc laisse croire qu'il ne s'est rien passé", async () => {
    const order = await ordrePromo();
    const dossier = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: order.id } });
    const events = await prisma.paymentRequestEvent.findMany({ where: { requestId: dossier.id } });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].message).toMatch(/automatiquement/i);
  });

  it("LA FILE DU DÉCAISSEMENT LE TROUVE — c'est ce qui rend le libellé cliquable", async () => {
    const order = await ordrePromo();
    const hrefs = await dossierHrefByOrder([order.id]);
    expect(hrefs.get(order.id)).toMatch(/^\/validations\/paiements\/.+/);
  });

  it("UNE DEMANDE DE PAIEMENT N'EN REÇOIT PAS UN SECOND — elle EST déjà son dossier", async () => {
    const order = await createExpenseOrder({
      label: `${TAG} demande native`, amount: 1000, category: "FOURNISSEUR",
      sourceType: "PAYMENT_REQUEST", sourceId: "pr-inexistant", requestedById: requesterId,
    });
    orders.push(order.id);
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: order.id } })).toBe(0);
  });

  it("SANS DEMANDEUR, PAS DE DOSSIER — inventer un demandeur porterait à l'audit un nom faux", async () => {
    const order = await createExpenseOrder({
      label: `${TAG} sans demandeur`, amount: 500, category: "AUTRE", sourceType: "PROMO_MATERIAL", sourceId: "pm-x",
    });
    orders.push(order.id);
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: order.id } })).toBe(0);
  });

  it("UN COMPAGNON NE SE TRANCHE PAS DANS LE DOSSIER — le serveur refuse, pas seulement l'écran", async () => {
    const order = await ordrePromo();
    const dossier = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: order.id } });
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const fd = new FormData();
    fd.set("id", dossier.id); fd.set("move", "APPROVE");
    const r = await decidePaymentRequest(fd);
    expect(r.ok).toBe(false);
    // La phrase EXACTE de la garde, lue à sa source : « /centre de paiement/ » passait déjà
    // AVANT que la garde ait un appelant — un autre refus disait les mêmes mots, et l'assertion
    // mesurait le vocabulaire ambiant, pas la garde (§118.17, §118.148).
    expect(r.error).toBe(canDecideFromDossier("EXPENSE_ORDER").reason);
  });

  it("ET IL NE SE RETIRE PAS NON PLUS — l'ordre resterait à régler sous un dossier « annulé »", async () => {
    const order = await ordrePromo();
    const dossier = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: order.id } });
    ACTOR = await actorFor(requesterId, "DIRECTION");
    const fd = new FormData();
    fd.set("id", dossier.id);
    const r = await cancelPaymentRequest(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/n'annulerait pas le paiement/i);
  });

  it("LE DEMANDEUR RELANCE, ET SIGNALE UNE URGENCE AVEC SON MOTIF", async () => {
    const order = await ordrePromo();
    const dossier = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: order.id } });
    ACTOR = await actorFor(requesterId, "DIRECTION");

    const relance = new FormData();
    relance.set("id", dossier.id); relance.set("kind", "REMINDER");
    expect((await nudgePaymentRequest(relance)).ok).toBe(true);

    // Deux fois dans l'heure : la seconde est refusée, sinon la notification devient du bruit.
    const encore = new FormData();
    encore.set("id", dossier.id); encore.set("kind", "REMINDER");
    const r2 = await nudgePaymentRequest(encore);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/moins d'une heure/);

    // Une urgence SANS motif n'est pas une urgence.
    const nu = new FormData();
    nu.set("id", dossier.id); nu.set("kind", "URGENT");
    expect((await nudgePaymentRequest(nu)).ok).toBe(false);

    const urgent = new FormData();
    urgent.set("id", dossier.id); urgent.set("kind", "URGENT"); urgent.set("comment", "Le fournisseur bloque la livraison.");
    expect((await nudgePaymentRequest(urgent)).ok).toBe(true);
    // L'URGENCE DÉPLACE LE DOSSIER DANS LA FILE, sinon elle n'est qu'un message de plus.
    const apres = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: dossier.id } });
    expect(apres.urgency).toBe("URGENT");
    const fil = await prisma.paymentRequestEvent.findMany({ where: { requestId: dossier.id, kind: "URGENT" } });
    expect(fil).toHaveLength(1);
    expect(fil[0].message).toMatch(/bloque la livraison/);
  });

  it("UN TIERS NE RELANCE PAS À LA PLACE DU DEMANDEUR", async () => {
    const order = await ordrePromo();
    const dossier = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: order.id } });
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const fd = new FormData();
    fd.set("id", dossier.id); fd.set("kind", "REMINDER");
    const r = await nudgePaymentRequest(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/demandeur/i);
  });

  it("LE RÈGLEMENT SOLDE LE DOSSIER — un dossier « chez les Finances » sous un virement fait ce matin est un mensonge", async () => {
    // Une demande au secrétariat : elle n'exige pas de facture, contrairement au matériel promo.
    const order = await createExpenseOrder({
      label: `${TAG} demande au secrétariat`, amount: 4000, category: "AUTRE",
      sourceType: "ADMIN_REQUEST", sourceId: `ar-${Math.random().toString(36).slice(2)}`,
      requestedById: requesterId,
    });
    orders.push(order.id);
    // LE CENTRE A AUTORISÉ — c'est son geste, pas celui qu'on teste ici. Sans lui, le règlement
    // est refusé, et c'est très bien : tout décaissement passe par le centre.
    await prisma.expenseOrder.update({ where: { id: order.id }, data: { centralStatus: "APPROVED" } });
    const dossier = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: order.id } });
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const fd = new FormData();
    fd.set("id", order.id);
    // LES FINANCES CLASSENT EN RÉGLANT, comme à l'écran — la première des trois chances. Sans ce choix,
    // le règlement cherchait une enveloppe couvrant le module d'origine dans la base PARTAGÉE : le cas
    // passait quand un banc voisin en avait laissé une, et tombait sinon (« rattachée à aucun budget »).
    // Un juge qui mesurait le voisinage (§118.92), tombé le 02/10 sur un règlement parfaitement juste.
    fd.set("budgetCategoryId", categorieId);
    const r = await settleExpenseOrder(fd);
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: dossier.id } });
    expect(apres.status).toBe("APPROVED");
    // Et le fil le DIT — sans quoi le dossier passerait de « chez les Finances » à « soldé »
    // sans que rien n'explique quand ni par qui.
    const fil = await prisma.paymentRequestEvent.findMany({ where: { requestId: dossier.id, kind: "APPROVE" } });
    expect(fil.length).toBeGreaterThan(0);
    expect(fil[0].message).toContain(order.reference);
  });
});
