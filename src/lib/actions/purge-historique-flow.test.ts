import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { depenseDuPoste, type FaitsDepensePoste } from "@/lib/budget/depense-poste";
import { chargerOrdresDesFinances } from "@/modules/finances/api";
import { purgeSettledExpenseOrders } from "@/modules/finances/actions-depenses";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * VIDER L'HISTORIQUE DES RÈGLEMENTS NE SUPPRIME AUCUN ORDRE (audit argent 2026-10-27, ARGENT-01).
 *
 * Un ordre réglé est un FAIT : le payé d'un poste, la garde « un BV à la fois », la paie le lisent.
 * Le TÉMOIN pur montre ce que coûtait sa suppression : le poste payé redevient « Engagé » — engagé
 * fantôme, et une seconde consommation ouverte. Le banc DB montre que la purge ne fait plus que
 * retirer l'ordre de l'historique de l'écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("le payé d'un poste se lit sur son ordre réglé", () => {
  const faits = (ordres: FaitsDepensePoste["ordres"]): FaitsDepensePoste => ({
    accorde: true, bcs: [{ id: "bc", montant: 80_000, signe: true, annule: false }], montantAccorde: 80_000,
    imputeeLe: new Date("2026-09-01"), annuleeLe: null, ordres,
  });
  it("TÉMOIN : sans son ordre PAYÉ, un poste payé redevient « Engagé » de tout son montant", () => {
    const paye = depenseDuPoste(faits([{ id: "o1", montant: 80_000, statut: "PAID", centralStatus: "APPROVED" }]));
    expect(paye.etat).toBe("PAYEE");
    expect(paye.engage).toBe(0);
    const purge = depenseDuPoste(faits([]));
    expect(purge.etat).toBe("ENGAGEE");
    expect(purge.engage).toBe(80_000);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__purgeHisto__${Date.now().toString(36)}`;

suite("purgeSettledExpenseOrders — un masque d'écran, jamais une suppression", () => {
  let adminId = "", societe = "", paye = "", annule = "", ouvert = "", ecriture = "", dossier = "";

  beforeAll(async () => {
    adminId = (await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    ACTEUR = { id: adminId, name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", access: {}, mustChangePassword: false };
    societe = (await prisma.company.create({ data: { name: `${TAG}Société` } })).id;
    ecriture = (await prisma.financeTransaction.create({
      data: { reference: `${TAG}-TX`, date: new Date(), direction: "OUT", category: "AUTRE", label: `${TAG} règlement`, amount: 80_000, method: "BANK_TRANSFER", account: "Banque", status: "SETTLED", companyId: societe },
    })).id;
    const mk = (suffixe: string, status: "PAID" | "CANCELLED" | "PENDING", transactionId: string | null = null) =>
      prisma.expenseOrder.create({
        data: { reference: `${TAG}-${suffixe}`, label: `${TAG} ${suffixe}`, amount: 80_000, companyId: societe, status, centralStatus: "APPROVED", transactionId, requestedById: adminId },
        select: { id: true },
      }).then((o) => o.id);
    paye = await mk("P", "PAID", ecriture);
    annule = await mk("C", "CANCELLED");
    ouvert = await mk("O", "PENDING");
    dossier = (await prisma.paymentRequest.create({
      data: { reference: `${TAG}-PAY`, title: `${TAG} compagnon`, amount: 80_000, payee: "x", requesterId: adminId, expenseOrderId: paye, origin: "EXPENSE_ORDER", status: "APPROVED" },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    await prisma.paymentRequest.deleteMany({ where: { id: dossier } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: ecriture } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societe } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
  });

  it("les ordres réglés et annulés RESTENT en base, avec leur écriture et leur dossier ; l'ordre ouvert n'est pas touché", async () => {
    const r = await purgeSettledExpenseOrders();
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const restants = await prisma.expenseOrder.findMany({ where: { id: { in: [paye, annule, ouvert] } }, select: { id: true, status: true, transactionId: true, historiqueMasqueLe: true } });
    expect(restants).toHaveLength(3);
    const parId = new Map(restants.map((o) => [o.id, o]));
    expect(parId.get(paye)?.status).toBe("PAID");
    expect(parId.get(paye)?.transactionId).toBe(ecriture);
    expect(parId.get(paye)?.historiqueMasqueLe).not.toBeNull();
    expect(parId.get(annule)?.historiqueMasqueLe).not.toBeNull();
    expect(parId.get(ouvert)?.historiqueMasqueLe).toBeNull();
    expect(await prisma.paymentRequest.count({ where: { id: dossier } })).toBe(1);
  });

  it("l'historique de l'écran ne les montre plus ; la file à régler garde l'ordre ouvert", async () => {
    const ids = (await chargerOrdresDesFinances({ companyId: societe })).map((o) => o.id);
    expect(ids).toContain(ouvert);
    expect(ids).not.toContain(paye);
    expect(ids).not.toContain(annule);
  });
});
