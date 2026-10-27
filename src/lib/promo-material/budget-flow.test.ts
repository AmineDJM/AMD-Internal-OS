import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { imputerBudgetMaterielPromo } from "@/lib/actions/promo-budget-actions";
import { engagementsDesCategories } from "@/lib/queries/budget-sources";
import { budgetPromoDeLaPiece } from "@/lib/queries/promo-budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL PROMOTIONNEL AU BUDGET — par les vrais points d'entrée (point 21, 27/10).
 *
 * « Matériel promotionnel hors budget » : la Direction Marketing impute une catégorie au dossier ; un BC SIGNÉ fait
 * monter l'ENGAGÉ de la catégorie ; l'ordre FOURNISSEUR de sa facture passe en consommé (en circuit), sans que le
 * même dinar compte deux fois ; la gamme du demandeur s'écrit sur le dossier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__mpbud__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

suite("Matériel promotionnel — imputé au Budget Marketing : BC signé en engagé, ordre fournisseur en consommé", () => {
  let nsId = "", pmId = "", kamId = "", buId = "", dossierId = "", bcId = "", factureId = "", ordreId = "";
  const cat: Record<string, string> = {};
  const annee = new Date().getUTCFullYear();

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    const [ns, pm, kam] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("pm", "PRODUCT_MANAGER"), mk("kam", "MEDICAL_DELEGATE")]);
    nsId = ns.id; pmId = pm.id; kamId = kam.id;
    // Le demandeur supervise UNE gamme : elle se lit sur lui, à coup sûr.
    buId = (await prisma.businessUnit.create({ data: { name: `${RUN}Cardiologie`, supervisorId: nsId } })).id;
    dossierId = (await prisma.promoMaterial.create({
      data: { reference: `${RUN}MP`, title: `${TAG}Kakémonos`, requesterId: nsId, circuitVersion: 2, circuitState: "IN_EXECUTION" },
      select: { id: true },
    })).id;
    const env = (await prisma.budgetEnvelope.create({
      data: { name: `${RUN}Ad & Pro`, domaine: "MARKETING", modules: ["EVENTS", "PROMO_MATERIAL"], totalAmount: 10_000_000, periodStart: new Date(`${annee}-01-01`), periodEnd: new Date(`${annee}-12-31`) },
      select: { id: true },
    })).id;
    cat.materiel = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env, name: `${TAG}Matériel promotionnel`, module: "PROMO_MATERIAL", allocated: 3_000_000 } })).id;
    cat.evenements = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env, name: `${TAG}Événements`, module: "EVENTS", allocated: 3_000_000 } })).id;
    bcId = (await prisma.legalDocument.create({
      data: { title: `${TAG}BC Imprimerie`, kind: "PURCHASE_ORDER", sourceType: "PROMO_MATERIAL", sourceId: dossierId, amount: 500_000, counterparty: "Imprimerie Atlas" },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    const comptes = [nsId, pmId, kamId].filter(Boolean);
    await prisma.legalDocument.updateMany({ where: { id: factureId || "_" }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: ordreId || "_" } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: dossierId } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: dossierId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  const engageDe = async (id: string) => {
    const e = await engagementsDesCategories([id], new Date(`${annee}-12-31`));
    return { engage: e.parCategorie.get(id) ?? 0, enCircuit: e.enCircuitParCategorie.get(id) ?? 0 };
  };

  it("seule la Direction Marketing impute — et pas sur une catégorie d'une autre nature", async () => {
    ACTOR = await acteur(kamId, "MEDICAL_DELEGATE");
    const pasElle = await imputerBudgetMaterielPromo(undefined, fd({ promoMaterialId: dossierId, budgetCategoryId: cat.materiel }));
    expect(pasElle.ok).toBe(false);
    expect(pasElle.error).toMatch(/Direction Marketing/);

    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    const mauvaise = await imputerBudgetMaterielPromo(undefined, fd({ promoMaterialId: dossierId, budgetCategoryId: cat.evenements }));
    expect(mauvaise.ok).toBe(false);
    expect(mauvaise.error).toMatch(/réservée aux dépenses « Événements »/);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: dossierId } })).budgetCategoryId).toBeNull();
  });

  it("imputé : la gamme du demandeur s'écrit ; un BC non signé n'engage rien", async () => {
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    const r = await imputerBudgetMaterielPromo(undefined, fd({ promoMaterialId: dossierId, budgetCategoryId: cat.materiel }));
    expect(r.ok, r.error).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: dossierId } });
    expect(pm.budgetCategoryId).toBe(cat.materiel);
    expect(pm.budgetImputeParId).toBe(pmId);
    expect(pm.businessUnitId, "la gamme du superviseur national").toBe(buId);
    expect(await engageDe(cat.materiel)).toEqual({ engage: 0, enCircuit: 0 });
  });

  it("LE TEST DE LA DIRECTION : BC signé → l'engagé de la catégorie monte", async () => {
    await prisma.legalDocument.update({ where: { id: bcId }, data: { signedAt: new Date() } });
    expect(await engageDe(cat.materiel)).toEqual({ engage: 500_000, enCircuit: 0 });
    // La catégorie voisine n'en porte rien.
    expect((await engageDe(cat.evenements)).engage).toBe(0);
  });

  it("l'ordre FOURNISSEUR de sa facture passe en consommé (en circuit) — jamais deux fois le même dinar", async () => {
    factureId = (await prisma.legalDocument.create({
      data: { title: `${TAG}Facture Imprimerie`, kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: dossierId, chainFromId: bcId, amount: 200_000, counterparty: "Imprimerie Atlas" },
      select: { id: true },
    })).id;
    // La facture d'un dossier imputé porte son budget, par quelque porte que parte son paiement.
    expect(await budgetPromoDeLaPiece({ sourceType: "LEGAL_DOCUMENT", sourceId: null, chainFromId: bcId })).toBe(cat.materiel);
    ordreId = (await prisma.expenseOrder.create({
      data: { reference: `${RUN}OD`, label: `${TAG}Facture Imprimerie`, amount: 200_000, category: "FOURNISSEUR", sourceType: "LEGAL_DOCUMENT", sourceId: factureId, status: "PENDING" },
      select: { id: true },
    })).id;
    await prisma.legalDocument.update({ where: { id: factureId }, data: { expenseOrderId: ordreId } });
    // 200 000 en circuit + 300 000 encore engagés sur le BC : le total reste celui du BC.
    expect(await engageDe(cat.materiel)).toEqual({ engage: 500_000, enCircuit: 200_000 });
  });

  it("changer de budget emporte l'ordre déjà né", async () => {
    const autre = (await prisma.budgetCategoryLine.create({
      data: { envelopeId: (await prisma.budgetCategoryLine.findUniqueOrThrow({ where: { id: cat.materiel } })).envelopeId, name: `${TAG}Matériel — kakémonos`, module: "PROMO_MATERIAL", allocated: 1_000_000 },
    })).id;
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    const r = await imputerBudgetMaterielPromo(undefined, fd({ promoMaterialId: dossierId, budgetCategoryId: autre }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).budgetCategoryId).toBe(autre);
    expect(await engageDe(autre)).toEqual({ engage: 500_000, enCircuit: 200_000 });
    expect((await engageDe(cat.materiel)).engage).toBe(0);
  });
});
