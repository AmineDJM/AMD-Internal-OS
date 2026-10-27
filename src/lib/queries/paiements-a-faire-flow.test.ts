import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { visibleToFinance, type CentralStatus } from "@/lib/payments/authorization";
import { chargerOrdresDesFinances, HISTORIQUE_MAX } from "./paiements-a-faire";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PAIEMENT AUTORISÉ NE SORT PAS DE LA FILE DES FINANCES PARCE QUE D'AUTRES ONT ÉTÉ CRÉÉS APRÈS LUI
 * (audit argent 2026-10-27, ARGENT-03).
 *
 * Un ordre autorisé et non réglé, plus ancien que les 300 derniers ordres de l'entité : l'ancienne
 * lecture (les 300 plus récents, tous états, filtrés ensuite) le perdait — le TÉMOIN le montre ; la
 * lecture de l'écran le garde. L'historique, lui, reste borné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fileFinances__${Date.now().toString(36)}`;

suite("file des Finances — la file à régler est entière, l'historique borné", () => {
  let societe = "";
  let ancien = "";

  beforeAll(async () => {
    societe = (await prisma.company.create({ data: { name: `${TAG}Société`, shortName: TAG.slice(0, 20) }, select: { id: true } })).id;
    const t0 = Date.now() - 400 * 60_000;
    ancien = (await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}-A`, label: `${TAG} autorisé, ancien`, amount: 125_000, companyId: societe,
        status: "PENDING", centralStatus: "APPROVED", createdAt: new Date(t0),
      },
      select: { id: true },
    })).id;
    // Après lui : des ordres qui attendent le centre (invisibles des Finances) et un historique réglé.
    await prisma.expenseOrder.createMany({
      data: Array.from({ length: HISTORIQUE_MAX + 20 }, (_, i) => ({
        reference: `${TAG}-${i}`, label: `${TAG} ${i}`, amount: 1_000, companyId: societe,
        status: i % 2 === 0 ? ("PENDING" as const) : ("PAID" as const),
        centralStatus: i % 2 === 0 ? "AWAITING" : "APPROVED",
        createdAt: new Date(t0 + (i + 1) * 60_000),
      })),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societe } }).catch(() => {});
  });

  it("TÉMOIN : la fenêtre commune des 300 plus récents perdait le paiement autorisé le plus ancien", async () => {
    const fenetre = (await prisma.expenseOrder.findMany({
      where: { companyId: societe }, orderBy: { createdAt: "desc" }, take: 300,
    })).filter((o) => visibleToFinance(o.centralStatus as CentralStatus));
    expect(fenetre.some((o) => o.id === ancien)).toBe(false);
  });

  it("la lecture de l'écran garde le paiement autorisé, et n'apporte aucun ordre en attente du centre", async () => {
    const ordres = await chargerOrdresDesFinances({ companyId: societe });
    expect(ordres.some((o) => o.id === ancien)).toBe(true);
    expect(ordres.every((o) => visibleToFinance(o.centralStatus as CentralStatus))).toBe(true);
  });

  it("l'historique (réglés, annulés) reste borné", async () => {
    const ordres = await chargerOrdresDesFinances({ companyId: societe });
    expect(ordres.filter((o) => o.status === "PAID" || o.status === "CANCELLED").length).toBeLessThanOrEqual(HISTORIQUE_MAX);
  });
});
