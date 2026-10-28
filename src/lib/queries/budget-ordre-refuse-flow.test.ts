import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { engagementsBruts } from "./budget-sources";

/**
 * UN ORDRE REFUSÉ PAR LE CENTRE NE RESTE PAS « ENGAGÉ » AU BUDGET (audit 27/10/2026, ARGENT-07).
 *
 * Le refus du centre laisse l'ordre `PENDING` : lu sur le seul statut, il pesait sur sa catégorie jusqu'à ce que
 * quelqu'un annule la source — l'enveloppe paraissait pleine et bloquait les arbitrages. Témoin : l'ordre voisin,
 * en attente du centre, compte toujours. (Enveloppe inactive : l'attribution automatique des ordres sans catégorie
 * ne vient pas y verser ceux des autres bancs.)
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zrefuse${Date.now().toString(36)}`;

suite("engagementsBruts — l'ordre refusé par le centre", () => {
  let envId = "", catId = "";
  beforeAll(async () => {
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Env`, isActive: false, modules: ["FINANCES"], periodStart: new Date("2020-01-01"), periodEnd: new Date("2099-12-31"), totalAmount: 1_000_000 } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Cat`, allocated: 1_000_000 } })).id;
    await prisma.expenseOrder.createMany({
      data: [
        { reference: `${TAG}-R`, label: `${TAG} refusé`, amount: 300_000, status: "PENDING", centralStatus: "REFUSED", budgetCategoryId: catId },
        { reference: `${TAG}-A`, label: `${TAG} en attente`, amount: 50_000, status: "PENDING", centralStatus: "AWAITING", budgetCategoryId: catId },
      ],
    });
  }, 60_000);
  afterAll(async () => {
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
  });

  it("seul l'ordre en attente pèse sur la catégorie", async () => {
    const e = await engagementsBruts([catId], new Date("2099-12-31"));
    expect(e.parCategorie.get(catId)).toBe(50_000);
    expect(e.enCircuitParCategorie.get(catId)).toBe(50_000);
  });
});
