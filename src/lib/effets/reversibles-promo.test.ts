import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — LE MATÉRIEL PROMOTIONNEL, RÉVERSIBLE : chaque action EXÉCUTÉE (la vraie, au clic de l'écran), puis ANNULÉE
 * contre la base locale. On vérifie l'état (statuts, ordre de paiement, déclaration, lignes abandonnées), le journal
 * et l'audit ; la CASCADE (un ordre payé depuis bloque tout, rien n'est écrit) ; et le RÉTABLISSEMENT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { annulerGeste, retablirGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { imputerBudgetMaterielPromo } from "@/lib/actions/promo-budget-actions";
import { annulerFacturePromo, demanderPaiementFacturePromo } from "@/lib/actions/promo-execution-actions";
import { cancelPromoMaterial, initiatePayment, settle } from "@/lib/actions/promo-material-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zk10cpromo${Date.now()}`;
let moi: CurrentUser;
let n = 0;
const dossiers: string[] = [];
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };

const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await annulerGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
const retablir = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await retablirGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
const traceeDe = async (gesteId: string) => {
  const g = await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteId } });
  expect(g.annuleParId).toBe(moi.id);
  expect(g.annuleLe).toBeTruthy();
  expect(await prisma.auditLog.count({ where: { entityId: gesteId, summary: { contains: "Annulation" } } })).toBe(1);
};

/** Un dossier de matériel promo, à l'état voulu. */
const dossier = async (data: Record<string, unknown>) => {
  n += 1;
  const pm = await prisma.promoMaterial.create({ data: { reference: `${TAG}-${n}`, title: `${TAG} dossier ${n}`, requesterId: moi.id, ...data } as never, select: { id: true } });
  dossiers.push(pm.id);
  return pm.id;
};
const statut = async (id: string) => prisma.promoMaterial.findUniqueOrThrow({ where: { id } });
const ordresDe = (sourceType: string, sourceId: string) => prisma.expenseOrder.findMany({ where: { sourceType, sourceId } as never });

/** Un BC SIGNÉ du dossier, et sa facture détaillée : une ligne reçue, une ligne qui ne l'est pas. */
const factureDetaillee = async (pmId: string) => {
  n += 1;
  const bc = await prisma.legalDocument.create({
    data: { title: `${TAG} BC ${n}`, kind: "PURCHASE_ORDER", sourceType: "PROMO_MATERIAL", sourceId: pmId, amount: 100_000, counterparty: `${TAG} Imprimerie`, signedAt: new Date(), bcCircuitAt: new Date() },
  });
  const facture = await prisma.legalDocument.create({
    data: { title: `${TAG} Facture ${n}`, reference: `${TAG}-F${n}`, kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pmId, amount: 100_000, counterparty: `${TAG} Imprimerie`, chainFromId: bc.id },
  });
  const detail = await prisma.promoFacture.create({ data: { legalDocumentId: facture.id, tvaRate: 0 } });
  const recue = await prisma.promoFactureLigne.create({ data: { factureId: detail.id, position: 0, designation: "Brochures", quantite: 100, prixUnitaire: 500, quantiteRecue: 100, recueLe: new Date() } });
  const manquante = await prisma.promoFactureLigne.create({ data: { factureId: detail.id, position: 1, designation: "Kakémonos", quantite: 10, prixUnitaire: 5_000 } });
  return { bc, facture, recue, manquante };
};

suite("K10c — matériel promotionnel : exécuter, annuler, rétablir", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Admin`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false } as unknown as CurrentUser;
    ACTOR = moi;
  }, 60_000);

  afterAll(async () => {
    const docs = (await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: { in: [...dossiers, ...docs] } }, { requestedById: moi.id }] }, select: { id: true } })).map((o) => o.id);
    const compagnons = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: moi.id } }).catch(() => undefined);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: docs } } }).catch(() => undefined);
    await prisma.legalDocument.updateMany({ where: { id: { in: docs } }, data: { expenseOrderId: null } }).catch(() => undefined);
    await prisma.promoMaterial.updateMany({ where: { id: { in: dossiers } }, data: { paymentOrderId: null, settlementOrderId: null } }).catch(() => undefined);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: compagnons } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: compagnons } } }).catch(() => undefined);
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => undefined);
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => undefined);
    await prisma.comment.deleteMany({ where: { entityId: { in: dossiers } } }).catch(() => undefined);
    await prisma.administrativeRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.promoMaterial.deleteMany({ where: { id: { in: dossiers } } }).catch(() => undefined);
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { OR: [{ userId: moi.id }, { title: { contains: TAG } }, { body: { contains: TAG } }] } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: moi.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: moi.id } }).catch(() => undefined);
  }, 60_000);

  it("imputer au budget : la catégorie d'avant revient (le dossier n'était imputé nulle part) ; rétablir la remet", async () => {
    const annee = new Date().getUTCFullYear();
    const env = await prisma.budgetEnvelope.create({ data: { name: `${TAG} Ad & Pro`, domaine: "MARKETING", modules: ["PROMO_MATERIAL"], totalAmount: 1_000_000, periodStart: new Date(`${annee}-01-01`), periodEnd: new Date(`${annee}-12-31`) } });
    const cat = await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG} Matériel promotionnel`, module: "PROMO_MATERIAL", allocated: 500_000 } });
    const pm = await dossier({ circuitVersion: 2, circuitState: "IN_EXECUTION" });
    const g = gesteDe(await imputerBudgetMaterielPromo(undefined, fd({ promoMaterialId: pm, budgetCategoryId: cat.id })));
    expect((await statut(pm)).budgetCategoryId).toBe(cat.id);
    const c = await annuler(g);
    expect(c.complet).toBe(true);
    const apres = await statut(pm);
    expect([apres.budgetCategoryId, apres.budgetImputeLe, apres.budgetImputeParId]).toEqual([null, null, null]);
    await traceeDe(g);
    await retablir(g);
    expect((await statut(pm)).budgetCategoryId).toBe(cat.id);
  });

  it("annuler une facture : la facture reprend son statut d'avant", async () => {
    const pm = await dossier({ circuitVersion: 2, circuitState: "IN_EXECUTION" });
    const facture = await prisma.legalDocument.create({ data: { title: `${TAG} Facture simple`, kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pm, amount: 20_000, counterparty: `${TAG} Imprimerie` } });
    const g = gesteDe(await annulerFacturePromo(fd({ promoMaterialId: pm, invoiceId: facture.id, motif: "doublon" })));
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facture.id } })).status).toBe("CANCELLED");
    await annuler(g);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: facture.id } });
    expect([doc.status, doc.cancelReason, doc.cancelledAt]).toEqual([facture.status, null, null]);
    await traceeDe(g);
  });

  it("demander le paiement d'une facture : l'ordre, son dossier compagnon et la déclaration sont retirés, les lignes abandonnées reviennent", async () => {
    const pm = await dossier({ circuitVersion: 2, circuitState: "IN_EXECUTION" });
    const { facture, manquante } = await factureDetaillee(pm);
    const g = gesteDe(await demanderPaiementFacturePromo(fd({ promoMaterialId: pm, invoiceId: facture.id, formalite: "AD_VISA", confirmeRenoncement: "1", motifRenoncement: `${TAG} carton abîmé` })));
    const [ordre] = await ordresDe("LEGAL_DOCUMENT", facture.id);
    expect(ordre).toBeTruthy();
    expect(Number(ordre.amount)).toBe(50_000);
    expect((await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: manquante.id } })).renonce).toBe(true);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: facture.id } })).toBe(1);
    const c = await annuler(g);
    // Ce qui reste « impossible » est seulement la poussée partie au centre de paiement — dite telle quelle.
    expect(c.details.filter((d) => d.issue === "IMPOSSIBLE").every((d) => /notification poussée/.test(d.quoi)), c.resume).toBe(true);
    expect(await prisma.expenseOrder.count({ where: { id: ordre.id } })).toBe(0);
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: ordre.id } })).toBe(0);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: facture.id } })).toBe(0);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facture.id } })).expenseOrderId).toBeNull();
    const ligne = await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: manquante.id } });
    expect([ligne.renonce, ligne.renonceMotif, ligne.renonceParId]).toEqual([false, null, null]);
    await traceeDe(g);
    // Rétablir : l'ordre revient (même identifiant), la facture le désigne de nouveau.
    await retablir(g);
    expect(await prisma.expenseOrder.count({ where: { id: ordre.id } })).toBe(1);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facture.id } })).expenseOrderId).toBe(ordre.id);
  });

  it("CASCADE : l'ordre a été PAYÉ depuis — l'annulation refuse, liste ce qui bloque, et n'écrit rien", async () => {
    const pm = await dossier({ circuitVersion: 2, circuitState: "IN_EXECUTION" });
    const { facture, manquante } = await factureDetaillee(pm);
    const g = gesteDe(await demanderPaiementFacturePromo(fd({ promoMaterialId: pm, invoiceId: facture.id, formalite: "MIP", confirmeRenoncement: "1", motifRenoncement: `${TAG} manque` })));
    const [ordre] = await ordresDe("LEGAL_DOCUMENT", facture.id);
    await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { status: "PAID", centralStatus: "AUTHORIZED" } as never });
    const r = await annulerGeste(g, moi);
    expect("refus" in r ? r.refus : "").toMatch(/Rien n'a été annulé/);
    expect("refus" in r ? r.bloquants?.length : 0).toBeGreaterThan(0);
    // Rien n'a bougé : l'ordre payé, la facture qui le désigne, la ligne abandonnée, la déclaration.
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } })).status).toBe("PAID");
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facture.id } })).expenseOrderId).toBe(ordre.id);
    expect((await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: manquante.id } })).renonce).toBe(true);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: facture.id } })).toBe(1);
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g } })).annuleLe).toBeNull();
  });

  it("lancer le paiement (ancien circuit) : le dossier revient au BC envoyé, l'ordre et son dossier compagnon sont retirés", async () => {
    const pm = await dossier({ circuitVersion: 1, status: "BC_SENT", chosenAgency: `${TAG} Agence`, chosenAmount: 80_000 });
    const g = gesteDe(await initiatePayment(fd({ id: pm })));
    const s = await statut(pm);
    expect(s.status).toBe("PAYMENT_INITIATED");
    const ordreId = s.paymentOrderId!;
    await annuler(g);
    const apres = await statut(pm);
    expect([apres.status, apres.paymentOrderId, apres.paymentInitiatedAt]).toEqual(["BC_SENT", null, null]);
    expect(await prisma.expenseOrder.count({ where: { id: ordreId } })).toBe(0);
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: ordreId } })).toBe(0);
    await traceeDe(g);
  });

  it("régler (ancien circuit), étape 1 puis étape 2 : chacune se défait — l'ordre de règlement retiré, puis « réglé » revient à « facturé »", async () => {
    const ar = await prisma.administrativeRequest.create({ data: { reference: `${TAG}-REQ1`, title: `${TAG} demande secrétariat`, type: "OTHER", requesterId: moi.id, status: "IN_PROGRESS" } as never });
    const pm = await dossier({ circuitVersion: 1, status: "INVOICED", chosenAgency: `${TAG} Agence`, chosenAmount: 60_000, adminRequestId: ar.id });
    // Étape 1 : l'ordre de règlement naît.
    const g1 = gesteDe(await settle(fd({ id: pm })));
    const ordreId = (await statut(pm)).settlementOrderId!;
    expect(ordreId).toBeTruthy();
    await annuler(g1);
    expect((await statut(pm)).settlementOrderId).toBeNull();
    expect(await prisma.expenseOrder.count({ where: { id: ordreId } })).toBe(0);
    await traceeDe(g1);
    // Rétabli, puis l'ordre est payé : l'étape 2 clôt le dossier — et se défait.
    await retablir(g1);
    expect((await statut(pm)).settlementOrderId).toBe(ordreId);
    await prisma.expenseOrder.update({ where: { id: ordreId }, data: { status: "PAID", centralStatus: "AUTHORIZED" } as never });
    const g2 = gesteDe(await settle(fd({ id: pm })));
    expect((await statut(pm)).status).toBe("SETTLED");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: ar.id } })).status).toBe("DONE");
    await annuler(g2);
    expect((await statut(pm)).status).toBe("INVOICED");
    const demande = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: ar.id } });
    expect([demande.status, demande.completedAt]).toEqual(["IN_PROGRESS", null]);
    // L'ordre payé, lui, n'a pas été touché par l'annulation de l'étape 2 : elle ne l'avait pas écrit.
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status).toBe("PAID");
    await traceeDe(g2);
  });

  it("annuler un dossier : le dossier, sa demande au secrétariat et son ordre non réglé reprennent leur statut d'avant", async () => {
    const ar = await prisma.administrativeRequest.create({ data: { reference: `${TAG}-REQ2`, title: `${TAG} demande à annuler`, type: "OTHER", requesterId: moi.id, status: "IN_PROGRESS" } as never });
    const pm = await dossier({ circuitVersion: 1, status: "BC_SENT", chosenAgency: `${TAG} Agence`, chosenAmount: 40_000, adminRequestId: ar.id });
    gesteDe(await initiatePayment(fd({ id: pm })));
    const ordreId = (await statut(pm)).paymentOrderId!;
    const g = gesteDe(await cancelPromoMaterial(fd({ id: pm, motif: `${TAG} plus besoin` })));
    expect((await statut(pm)).status).toBe("CANCELLED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status).toBe("CANCELLED");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: ar.id } })).status).toBe("CANCELLED");
    const c = await annuler(g);
    expect(c.complet, c.resume).toBe(true);
    expect((await statut(pm)).status).toBe("PAYMENT_INITIATED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status).toBe("PENDING");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: ar.id } })).status).toBe("IN_PROGRESS");
    // Le mot au fil, écrit par l'annulation du dossier, est retiré avec elle.
    expect(await prisma.comment.count({ where: { entityId: pm, body: { contains: `${TAG} plus besoin` } } as never })).toBe(0);
    await traceeDe(g);
    await retablir(g);
    expect((await statut(pm)).status).toBe("CANCELLED");
  });
});
