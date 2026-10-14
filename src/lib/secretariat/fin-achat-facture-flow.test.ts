import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { createRequest, requestApproval, decideApproval, finishRequest } from "@/lib/actions/admin-request-actions";
import { createPurchaseRequest } from "@/lib/actions/purchase-request-actions";
import { createInvoice } from "@/lib/actions/invoice-actions";
import { settleExpenseOrder } from "@/lib/actions/expense-actions";
import { createExpenseOrder } from "@/lib/expense-orders";
import { ordresAvecFacture } from "@/lib/finance/facture-ordre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « FIN DE LA DEMANDE » D'UN ACHAT : la facture se lit là où l'écran la range (lot E5).
 *
 * La règle ne regardait que les fichiers « Facture » déposés sur la demande ; la même fiche propose
 * « Pièces liées → Facture », qui range la facture AU REGISTRE avec son PDF — et une demande dont la
 * facture était parfaitement rangée là ne se terminait jamais. Une seule règle désormais, celle des
 * ordres de dépense (`finance/facture-ordre.ts`). Par les vrais gestes : la demande se dépose, se
 * valide et se termine par les actions de l'écran ; la facture se crée par `createInvoice`, PDF joint.
 * L'assistante qui termine n'a pas la vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__e5fin";
const TAG = `${PREFIXE}${Date.now().toString(36)}__`;

const form = (o: Record<string, string>, fichiers: File[] = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  for (const x of fichiers) f.append("attachment", x);
  return f;
};
// UNE FACTURE DISTINCTE PAR DÉPÔT (Direction, 14/10) : le même fichier deux fois serait la même facture, refusée.
const pdf = () => new File([new Uint8Array([37, 80, 68, 70, 45, 49]), `${Date.now()}-${Math.random()}`], "facture.pdf", { type: "application/pdf" });
async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false };
}

suite("Secrétariat — la fin d'un achat trouve sa facture où l'écran la range, et le règlement ne ressuscite rien", () => {
  const u: Record<string, string> = {};
  let departementId = "";
  let categorieId = "";
  let n = 0;

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    const demandes = comptes.length
      ? (await prisma.administrativeRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true } })).map((x) => x.id)
      : [];
    const ordres = (await prisma.expenseOrder.findMany({
      where: { OR: [{ sourceType: "ADMIN_REQUEST", sourceId: { in: demandes } }, { label: { contains: PREFIXE } }] },
      select: { id: true },
    })).map((x) => x.id);
    const pieces = (await prisma.legalDocument.findMany({ where: { title: { contains: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    await prisma.paymentRequest.deleteMany({ where: { OR: [{ expenseOrderId: { in: ordres } }, { requesterId: { in: comptes } }] } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { label: { contains: PREFIXE } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { OR: [{ name: { startsWith: PREFIXE } }, { entityId: { in: [...pieces, ...ordres, ...demandes] } }] } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: pieces } }, data: { chainFromId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.departmentBudgetExpense.deleteMany({ where: { adminRequestId: { in: demandes } } }).catch(() => {});
    await prisma.purchaseRequestLogEntry.deleteMany({ where: { requestId: { in: demandes } } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { requestId: { in: demandes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...demandes, ...ordres, ...pieces] } }, { actorId: { in: comptes } }] } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    const fiches = (await prisma.employee.findMany({ where: { userId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    await prisma.employee.updateMany({ where: { id: { in: fiches } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const companyId = (await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } }))!.id;
    const roles = [["dem", "MEDICAL_DELEGATE"], ["n1", "HEAD_OF_SALES"], ["asst", "DIRECTION_ASSISTANT"], ["fin", "FINANCE_BUDGET_MANAGER"]] as const;
    const comptes = await Promise.all(roles.map(([k, role]) =>
      prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })));
    roles.forEach(([k], i) => { u[k] = comptes[i].id; });
    // LE BUDGET DU BANC (§118.182) : une enveloppe à lui, qui ne couvre aucun module, et une catégorie où les
    // Finances classent au règlement ; un département à lui pour l'imputation aux moyens généraux.
    const [n1, env, dept] = await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} n1`, userId: u.n1, companyId, isActive: true } }),
      prisma.budgetEnvelope.create({ data: { name: `${TAG}enveloppe`, periodStart: new Date("2026-01-01"), periodEnd: new Date("2027-12-31") } }),
      prisma.department.create({ data: { name: `${TAG}département`, code: `${TAG}DEP` } }),
    ]);
    departementId = dept.id;
    const [, categorie] = await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} dem`, userId: u.dem, companyId, isActive: true, managerId: n1.id } }),
      prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}catégorie` } }),
    ]);
    categorieId = categorie.id;
  }, 120_000);
  afterAll(async () => { await nettoyer(); await prisma.$disconnect().catch(() => {}); }, 120_000);

  /** Un achat déposé par le demandeur et validé par son directeur — les vrais gestes. */
  async function achatValide(): Promise<string> {
    const libelle = `${TAG}achat ${++n}`;
    ACTOR = await acteur(u.dem);
    const r = await createPurchaseRequest(undefined, form({ title: libelle, lines: JSON.stringify([{ articleId: null, label: libelle, quantity: 1, unitPrice: 4000 }]) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: r.id! }, select: { id: true } });
    ACTOR = await acteur(u.n1);
    const d = await decideApproval(form({ approvalId: appro.id, decision: "APPROVED" }));
    expect(d.ok, d.ok ? "" : d.error).toBe(true);
    return r.id!;
  }
  /** « Fin de la demande » par l'assistante, avec son imputation aux moyens généraux. */
  async function terminer(id: string) {
    ACTOR = await acteur(u.asst);
    return finishRequest(form({ id, budgetDepartmentId: departementId, budgetAmount: "4000" }));
  }
  const statut = async (id: string) => (await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  /** Une facture créée par « Pièces liées → Facture » — le vrai geste, PDF joint ou non. */
  async function facture(champs: Record<string, string>, avecPdf: boolean): Promise<string> {
    ACTOR = await acteur(u.asst);
    const r = await createInvoice(undefined, form({ title: `${TAG}facture ${++n}`, amount: "4000", direction: "OUT", ...champs }, avecPdf ? [pdf()] : []));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (avecPdf) expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } }), "le PDF est bien parti avec la facture").toBeGreaterThan(0);
    return r.id!;
  }
  /** Le BC rattaché à une fiche — ce que crée « Pièces liées → Bon de commande ». */
  const bonDeCommande = (sourceType: "ADMIN_REQUEST" | "SPONSORING", sourceId: string, status: "ACTIVE" | "CANCELLED" = "ACTIVE") =>
    prisma.legalDocument.create({ data: { title: `${TAG}BC ${++n}`, kind: "PURCHASE_ORDER", status, sourceType, sourceId }, select: { id: true } });

  it("PRÉMISSES : l'assistante gère le bureau et le registre sans la vue globale ; les Finances règlent", async () => {
    const asst = await acteur(u.asst);
    expect(hasGlobalView(asst.role)).toBe(false);
    expect(userCan(asst, "ADMIN_REQUESTS", "UPDATE"), "elle termine la demande").toBe(true);
    expect(userCan(asst, "LEGAL", "CREATE"), "elle crée la facture au registre").toBe(true);
    expect(userCan(await acteur(u.fin), "FINANCES", "UPDATE")).toBe(true);
  });

  it("LE TÉMOIN : sans facture nulle part, la fin est refusée — et le refus nomme « Pièces liées → Facture »", async () => {
    const id = await achatValide();
    const r = await terminer(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Pièces liées → Facture/);
    expect(await statut(id)).not.toBe("DONE");
  });

  it("un fichier « Facture » dans les Documents de la demande suffit (règle d'avant, gardée)", async () => {
    const id = await achatValide();
    await prisma.document.create({ data: { name: `${TAG}facture`, category: "INVOICE", entityType: "ADMIN_REQUEST", entityId: id } });
    const r = await terminer(id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await statut(id)).toBe("DONE");
  });

  it("LA FACTURE AU REGISTRE par « Pièces liées → Facture », avec son PDF : la demande se termine — avant, jamais", async () => {
    const id = await achatValide();
    await facture({ sourceType: "ADMIN_REQUEST", sourceId: id }, true);
    const r = await terminer(id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await statut(id)).toBe("DONE");
  });

  it("une facture au registre SANS son fichier, ou ANNULÉE, ne compte pas", async () => {
    const sansFichier = await achatValide();
    await facture({ sourceType: "ADMIN_REQUEST", sourceId: sansFichier }, false);
    expect((await terminer(sansFichier)).ok, "une ligne de registre sans pièce ne prouve rien").toBe(false);

    const annulee = await achatValide();
    const f = await facture({ sourceType: "ADMIN_REQUEST", sourceId: annulee }, true);
    await prisma.legalDocument.update({ where: { id: f }, data: { status: "CANCELLED" } });
    expect((await terminer(annulee)).ok, "une facture annulée n'est pas la facture").toBe(false);
  });

  it("LA FACTURE QUI SUIT UN BC DE LA DEMANDE compte ; celle qui suit le BC d'une AUTRE demande, non — le lien, jamais la ressemblance", async () => {
    const id = await achatValide();
    const bc = await bonDeCommande("ADMIN_REQUEST", id);
    await facture({ chainFromId: bc.id }, true);
    const r = await terminer(id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    // LE TÉMOIN : même montant, même nature, même titre de BC — mais le BC d'une demande VOISINE.
    const voisine = await achatValide();
    const seule = await achatValide();
    const bcVoisin = await bonDeCommande("ADMIN_REQUEST", voisine);
    await facture({ chainFromId: bcVoisin.id }, true);
    expect((await terminer(seule)).ok, "la facture du BC voisin n'est pas la facture de cette demande").toBe(false);
  });

  it("la facture de l'un de ses ORDRES de dépense compte ; celle d'un ordre ANNULÉ, non", async () => {
    const id = await achatValide();
    const ordre = await createExpenseOrder({ label: `${TAG}ordre`, amount: 4000, category: "AUTRE", sourceType: "ADMIN_REQUEST", sourceId: id, requestedById: u.asst });
    await prisma.document.create({ data: { name: `${TAG}facture ordre`, category: "INVOICE", entityType: "EXPENSE_ORDER", entityId: ordre.id } });
    expect((await terminer(id)).ok).toBe(true);

    const annule = await achatValide();
    const ordreAnnule = await createExpenseOrder({ label: `${TAG}ordre annulé`, amount: 4000, category: "AUTRE", sourceType: "ADMIN_REQUEST", sourceId: annule, requestedById: u.asst });
    await prisma.expenseOrder.update({ where: { id: ordreAnnule.id }, data: { status: "CANCELLED" } });
    await prisma.document.create({ data: { name: `${TAG}facture ordre annulé`, category: "INVOICE", entityType: "EXPENSE_ORDER", entityId: ordreAnnule.id } });
    expect((await terminer(annule)).ok, "un ordre annulé ne paie rien : sa facture ne termine rien").toBe(false);
  });

  it("CÔTÉ ORDRES : la facture chaînée au BC de la fiche vaut pour ses ordres — pas pour ceux d'une autre fiche, ni par un BC annulé", async () => {
    const fiche = (k: string) => `${TAG}fiche-${k}`;
    const mk = (k: string) => createExpenseOrder({ label: `${TAG}ordre ${k}`, amount: 100, category: "AUTRE", sourceType: "SPONSORING", sourceId: fiche(k), requestedById: u.asst });
    const [a, b, c] = await Promise.all([mk("a"), mk("b"), mk("c")]);
    const bcA = await bonDeCommande("SPONSORING", fiche("a"));
    const bcC = await bonDeCommande("SPONSORING", fiche("c"), "CANCELLED");
    await facture({ chainFromId: bcA.id }, true);
    await facture({ chainFromId: bcC.id }, true);
    const vus = await ordresAvecFacture([a, b, c].map((o) => ({ id: o.id, sourceType: o.sourceType, sourceId: o.sourceId })));
    expect(vus.has(a.id), "la facture suit le BC de SA fiche").toBe(true);
    expect(vus.has(b.id), "aucun lien vers la fiche b").toBe(false);
    expect(vus.has(c.id), "un BC annulé ne relie plus rien").toBe(false);
  });

  it("E5-4 — LE RÈGLEMENT NE RESSUSCITE PAS une demande terminée ; il fait avancer celle qui attend son paiement", async () => {
    // Une demande terminée AVANT que son approbation chiffrée ne soit tranchée (comme `demandeur-flow`).
    ACTOR = await acteur(u.dem);
    const c = await createRequest(undefined, form({ type: "OTHER", title: `${TAG}terminée avant paiement`, priority: "MEDIUM" }));
    expect(c.ok).toBe(true);
    ACTOR = await acteur(u.asst);
    expect((await requestApproval(form({ requestId: c.id!, validatorId: u.n1, amount: "9000" }))).ok).toBe(true);
    // « Fin » est refusée tant que la validation attend (audit du 14/10/2026) : la demande terminée avant se simule en base.
    expect((await finishRequest(form({ id: c.id! }))).ok).toBe(false);
    await prisma.administrativeRequest.update({ where: { id: c.id! }, data: { status: "DONE", completedAt: new Date() } });
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: c.id! }, select: { id: true } });
    ACTOR = await acteur(u.n1);
    expect((await decideApproval(form({ approvalId: appro.id, decision: "APPROVED" }))).ok).toBe(true);

    // Le témoin : une demande dont l'approbation chiffrée est accordée, en attente de son paiement.
    ACTOR = await acteur(u.dem);
    const t = await createRequest(undefined, form({ type: "OTHER", title: `${TAG}en attente de paiement`, priority: "MEDIUM" }));
    ACTOR = await acteur(u.asst);
    expect((await requestApproval(form({ requestId: t.id!, validatorId: u.n1, amount: "7000" }))).ok).toBe(true);
    const apT = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: t.id! }, select: { id: true } });
    ACTOR = await acteur(u.n1);
    expect((await decideApproval(form({ approvalId: apT.id, decision: "APPROVED" }))).ok).toBe(true);
    expect(await statut(t.id!)).toBe("AWAITING_PAYMENT");

    for (const id of [c.id!, t.id!]) {
      const ordre = await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "ADMIN_REQUEST", sourceId: id }, select: { id: true } });
      // LE CENTRE A AUTORISÉ — son geste, pas celui qu'on éprouve ici.
      await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { centralStatus: "APPROVED" } });
      ACTOR = await acteur(u.fin);
      const r = await settleExpenseOrder(form({ id: ordre.id, budgetCategoryId: categorieId }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    expect(await statut(c.id!), "avant : « en cours » sur une demande terminée, sans que personne l'ait rouverte").toBe("DONE");
    expect(await statut(t.id!), "le témoin : celle qui attendait son paiement reprend").toBe("IN_PROGRESS");
  });
});
