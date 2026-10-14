import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestBV } from "@/lib/actions/regulatory-actions";
import { decidePayment } from "@/lib/actions/payment-centre-actions";
import { settleExpenseOrder } from "@/lib/actions/expense-actions";
import { canAccessEntity } from "@/lib/entity-access";
import type { RegWorkflowState } from "@/lib/regulatory-workflow";
import { natureDeLOrdreBv, ordreQuiDitLEtat, etatDeLOrdreBv, bloqueUneNouvelleDemande } from "./bv-circuit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BV D'UN DOSSIER, DE L'ÉTAPE AU PAIEMENT — par les VRAIS points d'entrée (Direction, 10/2026).
 *
 * « Demande du BV 25 % » se clique (pièce jointe et commentaire facultatifs) → le centre de paiement voit
 * de quel produit elle vient → autorisée, elle va aux Finances → payée, les Finances déposent la quittance
 * et l'étape « Paiement du BV » se coche. Le centre peut refuser (« Non prioritaire ») : l'étape le dit,
 * et l'on redemande. Un double clic ne fait pas deux ordres.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__bvcircuit${Date.now().toString(36)}__`;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false } as CurrentUser;
}
const form = (fields: Record<string, string>, files: Record<string, File> = {}): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const [k, f] of Object.entries(files)) fd.append(k, f);
  return fd;
};
const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: "application/pdf" });

/** Les ordres du dossier, lus comme la fiche les lit (état + motif du refus). */
const ordresDuDossier = (productId: string) => prisma.expenseOrder.findMany({
  where: { sourceType: "REGULATORY_PRODUCT", sourceId: productId },
  select: {
    id: true, reference: true, label: true, status: true, centralStatus: true, createdAt: true, notes: true, sourceType: true,
    centralMessages: { where: { decision: "REFUSE" }, orderBy: { createdAt: "desc" }, take: 1, select: { body: true } },
  },
  orderBy: { createdAt: "desc" },
});

suite("BV d'un dossier réglementaire — étape → centre de paiement → Finances → quittance", () => {
  let raId = "", dirId = "", saId = "", siegeId = "", tiersId = "", societeId = "", produitId = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    raId = (await mk("ra", "SUPER_ADMIN")).id;
    dirId = (await mk("dir", "DIRECTION")).id;
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    siegeId = (await mk("siege", "COORDINATOR")).id;
    tiersId = (await mk("tiers", "COORDINATOR")).id;
    await prisma.paymentCentreSeat.create({ data: { userId: siegeId, grantedById: saId, note: TAG } });
    societeId = (await prisma.company.create({ data: { name: `${TAG}Société` } })).id;
    produitId = (await prisma.regulatoryProduct.create({
      data: { dci: `${TAG}PARACETAMOL`, brandName: `${TAG}Doliprane`, reference: `${TAG}REG`, companyId: societeId },
    })).id;
  });

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: produitId }, select: { id: true, transactionId: true } });
    const oIds = ordres.map((o) => o.id);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: oIds } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => undefined);
    const docs = await prisma.document.findMany({ where: { OR: [{ entityId: { in: oIds } }, { entityId: produitId }] }, select: { id: true, fileKey: true } });
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => undefined);
    await prisma.storedFile.deleteMany({ where: { key: { in: docs.map((d) => d.fileKey).filter((k): k is string => Boolean(k)) } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: oIds } } }).catch(() => undefined);
    const tx = ordres.map((o) => o.transactionId).filter((t): t is string => Boolean(t));
    await prisma.financeTransaction.deleteMany({ where: { id: { in: tx } } }).catch(() => undefined);
    const comptes = [raId, dirId, saId, siegeId, tiersId];
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => undefined);
    await prisma.paymentCentreSeat.deleteMany({ where: { userId: siegeId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => undefined);
  });

  it("demande depuis l'étape, avec commentaire et pièce : ordre EN ATTENTE du centre, produit lisible, pièce ouverte au siège", async () => {
    ACTOR = await actorFor(raId, "SUPER_ADMIN");
    const r = await requestBV(form(
      { productId: produitId, stepKey: "bv25_req", bvType: "BV 75 %", amount: "150000", note: "Échéance ANPP le 30 — urgent" },
      { files: pdf("proforma-bv.pdf") },
    ));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const ordres = await ordresDuDossier(produitId);
    expect(ordres).toHaveLength(1);
    const o = ordres[0]!;
    expect(o.centralStatus, "le centre d'abord").toBe("AWAITING");
    // L'ÉTAPE décide de la nature, pas le `bvType` envoyé à côté.
    expect(natureDeLOrdreBv(o)).toBe("25");
    expect(o.label).toContain(`${TAG}REG`);
    expect(o.notes).toBe("Échéance ANPP le 30 — urgent");
    expect(etatDeLOrdreBv(o)).toBe("DEMANDE");

    const pieces = await prisma.document.findMany({ where: { entityType: "EXPENSE_ORDER", entityId: o.id } });
    expect(pieces.map((p) => p.name)).toEqual(["proforma-bv.pdf"]);
    // Le siège NOMMÉ du centre (sans module Finances) ouvre la pièce ; un tiers, non.
    expect(await canAccessEntity(await actorFor(siegeId, "COORDINATOR"), "EXPENSE_ORDER", o.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(await actorFor(tiersId, "COORDINATOR"), "EXPENSE_ORDER", o.id, "VIEW")).toBe(false);

    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: produitId }, select: { workflow: true } });
    expect((p.workflow as RegWorkflowState).bv25_req?.status, "la demande EST l'étape").toBe("DONE");
  });

  it("une seconde demande du même BV est refusée — y compris deux clics simultanés sur l'autre BV", async () => {
    ACTOR = await actorFor(raId, "SUPER_ADMIN");
    const r = await requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "150000" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("déjà demandé");
    expect(await prisma.expenseOrder.count({ where: { sourceId: produitId } })).toBe(1);

    const [a, b] = await Promise.all([
      requestBV(form({ productId: produitId, stepKey: "bv75_req", amount: "450000" })),
      requestBV(form({ productId: produitId, stepKey: "bv75_req", amount: "450000" })),
    ]);
    expect([a.ok, b.ok].filter(Boolean), "un seul ordre pour deux clics").toHaveLength(1);
    const bv75 = (await ordresDuDossier(produitId)).filter((o) => natureDeLOrdreBv(o) === "75");
    expect(bv75).toHaveLength(1);
  });

  it("refus « Non prioritaire » : l'étape le dit avec le motif, et l'on peut redemander", async () => {
    const o25 = (await ordresDuDossier(produitId)).find((o) => natureDeLOrdreBv(o) === "25")!;
    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await decidePayment(form({ id: o25.id, decision: "REFUSE", body: "Non prioritaire" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const lu = ordreQuiDitLEtat(await ordresDuDossier(produitId), "25");
    expect(lu?.etat).toBe("REFUSE");
    expect(lu?.ordre.centralMessages[0]?.body).toBe("Non prioritaire");
    expect(bloqueUneNouvelleDemande(lu!.ordre)).toBe(false);

    ACTOR = await actorFor(raId, "SUPER_ADMIN");
    const re = await requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "150000", note: "Relance : dépôt bloqué sans ce BV" }));
    expect(re.ok, re.ok ? "" : re.error).toBe(true);
    const apres = ordreQuiDitLEtat(await ordresDuDossier(produitId), "25");
    expect(apres?.etat, "la nouvelle demande prend la place du refus").toBe("DEMANDE");
    expect(apres?.ordre.id).not.toBe(o25.id);
  });

  it("autorisé → chez les Finances ; payé avec la quittance → l'étape « Paiement du BV 25 % » est cochée", async () => {
    const o25 = ordreQuiDitLEtat(await ordresDuDossier(produitId), "25")!.ordre;
    ACTOR = await actorFor(dirId, "DIRECTION");
    const ok = await decidePayment(form({ id: o25.id, decision: "APPROVE", body: "" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(ordreQuiDitLEtat(await ordresDuDossier(produitId), "25")?.etat).toBe("AUTORISE");

    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const categorie = await prisma.budgetCategoryLine.findFirst({ where: { envelope: { isActive: true } }, select: { id: true } });
    const base = { id: o25.id, ...(categorie ? { budgetCategoryId: categorie.id } : {}) };

    const sansPiece = await settleExpenseOrder(form(base));
    expect(sansPiece.ok).toBe(false);
    expect(sansPiece.error).toContain("Quittance obligatoire");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o25.id } })).status).toBe("PENDING");

    const paye = await settleExpenseOrder(form(base, { quittance: pdf("quittance-bv25.pdf") }));
    expect(paye.ok, paye.ok ? "" : paye.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o25.id } })).status).toBe("PAID");

    const quittances = await prisma.document.findMany({
      where: { entityType: "REGULATORY_PRODUCT", entityId: produitId, category: "BV_RECEIPT" },
      select: { name: true, stepKey: true },
    });
    expect(quittances).toEqual([{ name: "quittance-bv25.pdf", stepKey: "bv25_pay" }]);
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: produitId }, select: { workflow: true } });
    expect((p.workflow as RegWorkflowState).bv25_pay?.status).toBe("DONE");
    expect(ordreQuiDitLEtat(await ordresDuDossier(produitId), "25")?.etat).toBe("PAYE");

    // Rejouer le règlement ne paie ni ne dépose une seconde fois.
    const encore = await settleExpenseOrder(form(base, { quittance: pdf("doublon.pdf") }));
    expect(encore.ok).toBe(true);
    expect(await prisma.document.count({ where: { entityType: "REGULATORY_PRODUCT", entityId: produitId, category: "BV_RECEIPT" } })).toBe(1);
    // Payé : la demande ne se refait plus.
    ACTOR = await actorFor(raId, "SUPER_ADMIN");
    const redemande = await requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "150000" }));
    expect(redemande.ok).toBe(false);
  });
});
