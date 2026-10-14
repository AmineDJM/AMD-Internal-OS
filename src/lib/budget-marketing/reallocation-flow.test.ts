import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getBudgetOverview } from "@/lib/queries/budget";
import { arbreCategories } from "@/lib/budget/marketing-vue";
import { reallouerCategorie } from "@/lib/actions/budget-pole-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__realloc${Date.now().toString(36)}__`;

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
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — RÉALLOUER, PAR LE VRAI POINT D'ENTRÉE (maquette « onglets » validée, 10/2026).
 *
 * « Sponsoring » (5 M alloués) a une sous-catégorie « Webinaires » qui répartit 3 M et a déjà payé 1,5 M : Sponsoring ne
 * peut céder que 2 M (son payé + engagé cumulé, 1,5 M, reste sous ce que ses sous-catégories répartissent, 3 M).
 * « Formation » est payée (350 000) sans allocation. Gardes : seul qui gère l'enveloppe réalloue ; bornes : jamais
 * au-delà du cessible ; l'enveloppe ne bouge pas ; chaque réallocation laisse son motif au journal de l'enveloppe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Budget Marketing — réallouer, borné à ce qu'une catégorie peut céder", () => {
  let pmId = "", finId = "", envId = "", spons = "", webinaires = "", formation = "", evenements = "";

  const alloueDe = async (id: string) => Number((await prisma.budgetCategoryLine.findUniqueOrThrow({ where: { id }, select: { allocated: true } })).allocated);
  const noeud = async (id: string) => {
    const ov = await getBudgetOverview(ACTOR as SessionUser, envId, null, null, { portee: "MARKETING" });
    return arbreCategories(ov!.categories).find((n) => n.id === id)!;
  };
  const reallouer = (sourceId: string, cibleId: string, montant: number, motif = "Formation ARV non prévue au budget") =>
    reallouerCategorie(form({ sourceId, cibleId, montant: String(montant), motif }));

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    pmId = (await mk("pm", "PRODUCT_MANAGER")).id;
    finId = (await mk("fin", "FINANCE_BUDGET_MANAGER")).id;
    const annee = new Date().getUTCFullYear();
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG} Ad & Pro`, domaine: "MARKETING", periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59)), totalAmount: 10_000_000 },
    })).id;
    spons = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Sponsoring`, allocated: 5_000_000 } })).id;
    webinaires = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, parentId: spons, name: `${TAG}Webinaires`, allocated: 3_000_000 } })).id;
    formation = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Formation`, allocated: 0 } })).id;
    evenements = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Événements`, allocated: 1_000_000 } })).id;
    const le = new Date(Date.UTC(annee, 5, 15));
    await prisma.budgetExpenseLine.createMany({
      data: [
        { categoryId: webinaires, reference: `${TAG}webinaire SAI`, amount: 1_500_000, date: le },
        { categoryId: formation, reference: `${TAG}formation ARV`, amount: 350_000, date: le },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    const cats = [webinaires, spons, formation, evenements].filter(Boolean);
    await prisma.auditLog.deleteMany({ where: { entityId: envId } }).catch(() => {});
    await prisma.budgetExpenseLine.deleteMany({ where: { categoryId: { in: cats } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { id: webinaires } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { id: { in: cats } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [pmId, finId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [pmId, finId] } } }).catch(() => {});
  });

  it("la part cessible : Sponsoring comprend ses Webinaires — 5 M − max(1,5 M payés, 3 M répartis) = 2 M", async () => {
    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    const n = await noeud(spons);
    expect(n.paye).toBe(1_500_000);
    expect(n.sousAlloue).toBe(3_000_000);
    expect(n.cessible).toBe(2_000_000);
    expect((await noeud(formation)).sante).toBe("SANS_ALLOCATION");
  });

  it("garde : les Finances lisent le Budget Marketing, elles ne réallouent pas", async () => {
    ACTOR = await actorFor(finId, "FINANCE_BUDGET_MANAGER");
    const r = await reallouer(evenements, formation, 100_000);
    expect(r.ok).toBe(false);
    expect(await alloueDe(evenements)).toBe(1_000_000);
    expect(await alloueDe(formation)).toBe(0);
  });

  it("bornes : refuse au-delà du cessible (même sous l'alloué), sans motif, depuis une sous-catégorie", async () => {
    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    const trop = await reallouer(spons, formation, 2_000_001);
    expect(trop.ok).toBe(false);
    expect(trop.error).toMatch(/ne peut céder que 2\s000\s000 DZD/);
    expect((await reallouer(spons, formation, 100_000, "  ")).ok).toBe(false);
    const sous = await reallouer(webinaires, formation, 100_000);
    expect(sous.ok).toBe(false);
    expect(sous.error).toMatch(/catégories de tête/);
    expect(await alloueDe(spons)).toBe(5_000_000);
    expect(await alloueDe(formation)).toBe(0);
  });

  it("réalloue dans la borne : l'enveloppe ne bouge pas, le motif reste au journal", async () => {
    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    const r = await reallouer(spons, formation, 350_000);
    expect(r.ok).toBe(true);
    expect(await alloueDe(spons)).toBe(4_650_000);
    expect(await alloueDe(formation)).toBe(350_000);
    const env = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id: envId }, select: { totalAmount: true } });
    expect(Number(env.totalAmount)).toBe(10_000_000);
    const journal = await prisma.auditLog.findMany({ where: { entityType: "BUDGET", entityId: envId, field: "reallocation" } });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ actorId: pmId, newValue: "350000" });
    expect(journal[0].summary).toMatch(/Réallocation de 350\s000 DZD .*Sponsoring.*Formation.*motif : Formation ARV non prévue au budget/);
    // Formation n'est plus « sans allocation » ; Sponsoring ne peut plus céder que 1 650 000.
    expect((await noeud(formation)).sante).toBe("DEPASSE");
    expect((await noeud(spons)).cessible).toBe(1_650_000);
  });

  it("la borne suit le payé : une dépense de plus sur la sous-catégorie, et la part cessible baisse d'autant", async () => {
    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    await prisma.budgetExpenseLine.create({ data: { categoryId: webinaires, reference: `${TAG}webinaire 2`, amount: 2_000_000, date: new Date(Date.UTC(new Date().getUTCFullYear(), 6, 1)) } });
    // Payé cumulé 3,5 M > réparti 3 M : le plancher devient le payé.
    expect((await noeud(spons)).cessible).toBe(1_150_000);
    expect((await reallouer(spons, evenements, 1_150_001)).ok).toBe(false);
    expect((await reallouer(spons, evenements, 1_150_000)).ok).toBe(true);
    expect(await alloueDe(spons)).toBe(3_500_000);
    expect((await noeud(spons)).cessible).toBe(0);
  });
});
