import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  getCurrentUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createExpenseOrder } from "@/lib/expense-orders";
import { cancelPaymentRequest, decidePaymentRequest } from "@/lib/actions/payment-request-actions";
import { cancelLegalDocument, sendLegalInvoiceToSettlement } from "@/lib/actions/legal-actions";
import { ordresAvecFacture } from "@/lib/finance/facture-ordre";
import { canSendToSettlement, ordreClos } from "@/lib/finances/settlement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PAIEMENT QUI N'A PLUS DE RAISON D'ÊTRE NE RESTE PAS PAYABLE ; UNE FACTURE RANGÉE SE VOIT ;
 * UNE FACTURE REFUSÉE AU CENTRE REPART (§118.185 — audit 360°, I6, I7, I8).
 *
 * Chaque cas part du VRAI point d'entrée (l'action serveur) et porte son TÉMOIN : le même geste,
 * là où la garde n'a rien à dire. Les acteurs ont de vrais rôles ; celui qui envoie une facture
 * au règlement est rattaché à UNE société, sans vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__ordresfermes__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

suite("ordres fermés, factures vues, factures renvoyées", () => {
  const u: Record<string, string> = {};
  let A = "", B = "";
  const session = async (k: string, role: string): Promise<SessionUser> =>
    ({ id: u[k], name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, secondaryRole: null, access: await getAccess(u[k], role as never) }) as unknown as SessionUser;

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ label: { startsWith: TAG } }, { requestedById: { in: comptes } }] }, select: { id: true } })).map((o) => o.id);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { OR: [{ title: { startsWith: TAG } }, { expenseOrderId: { in: ordres } }] }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentPiece.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    const legal = (await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    await prisma.legalDocument.updateMany({ where: { id: { in: legal } }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.promoFacture.deleteMany({ where: { legalDocumentId: { in: legal } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legal } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    for (const [k, role, soc] of [["demandeur", "VIEWER", A], ["fin", "FINANCE_BUDGET_MANAGER", A], ["sa", "SUPER_ADMIN", A], ["asst", "DIRECTION_ASSISTANT", A]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
      await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId: soc, userId: u[k] } });
    }
  }, 60_000);

  afterAll(async () => { await nettoyer(); }, 60_000);

  /** Une demande de paiement ORDINAIRE soumise : son ordre naît à la soumission, comme à l'écran. */
  async function demandeSoumise(titre: string) {
    const req = await prisma.paymentRequest.create({
      data: { reference: `${TAG}${titre}`.slice(0, 40), title: `${TAG}${titre}`, amount: 1000, payee: "Fournisseur", requesterId: u.demandeur, status: "SUBMITTED", companyId: A },
    });
    const order = await createExpenseOrder({ label: `${TAG}${titre}`, amount: 1000, category: "FOURNISSEUR", sourceType: "PAYMENT_REQUEST", sourceId: req.id, requestedById: u.demandeur });
    await prisma.paymentRequest.update({ where: { id: req.id }, data: { expenseOrderId: order.id } });
    return { reqId: req.id, orderId: order.id };
  }
  const statutOrdre = async (id: string) => (await prisma.expenseOrder.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const statutDossier = async (id: string) => (await prisma.paymentRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  // ── I7 : l'ordre fantôme ─────────────────────────────────────────────────────────────────
  it("RETIRER sa demande annule son ordre non réglé — et l'écran le dit", async () => {
    const d = await demandeSoumise("retrait");
    ACTEUR = await session("demandeur", "VIEWER");
    const r = await cancelPaymentRequest(fd({ id: d.reqId }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/est annulé : il ne sera pas payé/);
    expect(await statutOrdre(d.orderId)).toBe("CANCELLED");
    expect(await statutDossier(d.reqId)).toBe("CANCELLED");
  });

  it("LE TÉMOIN : un ordre déjà RÉGLÉ n'est pas défait, et la demande ne se retire pas — rien n'est touché", async () => {
    const d = await demandeSoumise("deja-regle");
    await prisma.expenseOrder.update({ where: { id: d.orderId }, data: { status: "PAID" } });
    ACTEUR = await session("demandeur", "VIEWER");
    const r = await cancelPaymentRequest(fd({ id: d.reqId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà réglé/);
    expect(await statutOrdre(d.orderId)).toBe("PAID");
    expect(await statutDossier(d.reqId)).toBe("SUBMITTED");
  });

  it("LE REFUS des Finances annule l'ordre non réglé", async () => {
    const d = await demandeSoumise("refus");
    ACTEUR = await session("fin", "FINANCE_BUDGET_MANAGER");
    const r = await decidePaymentRequest(fd({ id: d.reqId, move: "REJECT", note: "pièces incohérentes" }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/il ne sera pas payé/);
    expect(await statutOrdre(d.orderId)).toBe("CANCELLED");
    expect(await statutDossier(d.reqId)).toBe("REJECTED");
  });

  it("LE TÉMOIN du refus : une mise en attente ne touche pas à l'ordre", async () => {
    const d = await demandeSoumise("attente");
    ACTEUR = await session("fin", "FINANCE_BUDGET_MANAGER");
    expect((await decidePaymentRequest(fd({ id: d.reqId, move: "HOLD", note: "trésorerie" }))).ok).toBe(true);
    expect(await statutOrdre(d.orderId)).toBe("PENDING");
  });

  /** Une facture au registre, de la société donnée, éventuellement partie au règlement. */
  async function facture(titre: string, companyId: string, opts: { ordre?: { status?: string; centralStatus?: string } } = {}) {
    const doc = await prisma.legalDocument.create({ data: { title: `${TAG}${titre}`, kind: "INVOICE", status: "ACTIVE", amount: 5000, companyId, counterparty: "Fournisseur" } });
    let orderId: string | null = null;
    if (opts.ordre) {
      const o = await createExpenseOrder({ label: `${TAG}${titre}`, amount: 5000, category: "FOURNISSEUR", sourceType: "LEGAL_DOCUMENT", sourceId: doc.id, requestedById: u.sa });
      orderId = o.id;
      await prisma.expenseOrder.update({ where: { id: o.id }, data: { ...(opts.ordre.status ? { status: opts.ordre.status as never } : {}), ...(opts.ordre.centralStatus ? { centralStatus: opts.ordre.centralStatus } : {}) } });
      await prisma.legalDocument.update({ where: { id: doc.id }, data: { expenseOrderId: o.id } });
    }
    return { docId: doc.id, orderId };
  }

  it("ANNULER une facture partie au règlement annule son ordre non réglé", async () => {
    const f = await facture("annulee", A, { ordre: {} });
    ACTEUR = await session("sa", "SUPER_ADMIN");
    const r = await cancelLegalDocument(fd({ id: f.docId, reason: "doublon fournisseur" }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/annulé avec elle/);
    expect(await statutOrdre(f.orderId as string)).toBe("CANCELLED");
  });

  it("LE TÉMOIN : une facture RÉGLÉE ne s'annule pas, et son ordre reste réglé", async () => {
    const f = await facture("reglee", A, { ordre: { status: "PAID" } });
    ACTEUR = await session("sa", "SUPER_ADMIN");
    const r = await cancelLegalDocument(fd({ id: f.docId, reason: "erreur" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà réglé/);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.docId } })).status).toBe("ACTIVE");
  });

  it("UNE FACTURE DONT DU MATÉRIEL EST ENTRÉ AU STOCK ne s'annule pas depuis Legal — et sans réception, elle s'annule", async () => {
    const f = await facture("stock", A);
    const pf = await prisma.promoFacture.create({ data: { legalDocumentId: f.docId, tvaRate: 19 } });
    const ligne = await prisma.promoFactureLigne.create({ data: { factureId: pf.id, designation: "Fiche", quantite: 10, prixUnitaire: 100, quantiteRecue: 10 } });
    ACTEUR = await session("sa", "SUPER_ADMIN");
    const r = await cancelLegalDocument(fd({ id: f.docId, reason: "erreur" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/réceptionnées au stock promotionnel/);
    // Le témoin : la réception défaite, l'annulation passe.
    await prisma.promoFactureLigne.update({ where: { id: ligne.id }, data: { quantiteRecue: null } });
    expect((await cancelLegalDocument(fd({ id: f.docId, reason: "erreur" }))).ok).toBe(true);
  });

  // ── I8 : la facture refusée au centre ────────────────────────────────────────────────────
  it("LA RÈGLE : un ordre refusé ou annulé est clos ; un ordre en attente ou autorisé ne l'est pas", () => {
    expect(ordreClos({ status: "PENDING", centralStatus: "REFUSED" })).toBe(true);
    expect(ordreClos({ status: "CANCELLED", centralStatus: "APPROVED" })).toBe(true);
    expect(ordreClos({ status: "PENDING", centralStatus: "AWAITING" })).toBe(false);
    expect(ordreClos({ status: "PENDING", centralStatus: "APPROVED" })).toBe(false);
    expect(ordreClos(null)).toBe(false);
    // Sans le fait de l'ordre, un lien bloque — la règle d'avant.
    expect(canSendToSettlement({ kind: "INVOICE", amount: 10, paidDate: null, expenseOrderId: "x" }).ok).toBe(false);
  });

  it("UNE FACTURE REFUSÉE AU CENTRE REPART : un nouvel ordre, et l'ancien est fermé", async () => {
    const f = await facture("refusee", A, { ordre: { centralStatus: "REFUSED" } });
    ACTEUR = await session("asst", "DIRECTION_ASSISTANT");
    const r = await sendLegalInvoiceToSettlement(fd({ id: f.docId }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/renvoyée au règlement/);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.docId }, select: { expenseOrderId: true } });
    expect(apres.expenseOrderId).not.toBe(f.orderId);
    expect(await statutOrdre(f.orderId as string)).toBe("CANCELLED");
  });

  it("LE TÉMOIN : une facture dont l'ordre attend le centre ne part pas une seconde fois", async () => {
    const f = await facture("en-attente", A, { ordre: { centralStatus: "AWAITING" } });
    ACTEUR = await session("asst", "DIRECTION_ASSISTANT");
    const r = await sendLegalInvoiceToSettlement(fd({ id: f.docId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà partie au règlement/);
    expect(await statutOrdre(f.orderId as string)).toBe("PENDING");
  });

  it("LA PORTE DE LA PIÈCE : la facture d'une autre société est introuvable pour qui ne la voit pas — la sienne part", async () => {
    const ailleurs = await facture("ailleurs", B);
    const chezSoi = await facture("chez-soi", A);
    ACTEUR = await session("asst", "DIRECTION_ASSISTANT");
    expect(await sendLegalInvoiceToSettlement(fd({ id: ailleurs.docId }))).toEqual({ ok: false, error: "Document introuvable." });
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: ailleurs.docId } })).expenseOrderId).toBeNull();
    expect((await sendLegalInvoiceToSettlement(fd({ id: chezSoi.docId }))).ok).toBe(true);
  });

  // ── I6 : où la plateforme range une facture ──────────────────────────────────────────────
  it("LA FACTURE D'UN ORDRE se lit aux six endroits où la plateforme la range — et pas ailleurs", async () => {
    const mk = (k: string, sourceType: string) =>
      createExpenseOrder({ label: `${TAG}${k}`, amount: 100, category: "EVENEMENT", sourceType: sourceType as never, sourceId: `${TAG}src-${k}`, requestedById: u.sa });
    const [surOrdre, surSource, surPoste, surDossier, surPiece, auRegistre, registreSansPiece, registreAnnule, sansRien] = await Promise.all(
      ["ordre", "source", "poste", "dossier", "piece", "registre", "sanspiece", "annule", "rien"].map((k) => mk(k, "SPONSORING")),
    );
    const doc = (entityType: string, entityId: string) =>
      prisma.document.create({ data: { name: `${TAG}facture`, category: "INVOICE", entityType: entityType as never, entityId } });
    await doc("EXPENSE_ORDER", surOrdre.id);
    await doc("SPONSORING", `${TAG}src-source`);
    const evenement = await prisma.event.create({ data: { name: `${TAG}evenement` } });
    const poste = await prisma.adProItem.create({ data: { label: `${TAG}poste`, expenseOrderId: surPoste.id, eventId: evenement.id } });
    await doc("AD_PRO_ITEM", poste.id);
    const compagnon = async (orderId: string) => (await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: orderId }, select: { id: true } })).id;
    await doc("PAYMENT_REQUEST", await compagnon(surDossier.id));
    const docPiece = await prisma.document.create({ data: { name: `${TAG}piece`, category: "OTHER", entityType: "PAYMENT_REQUEST", entityId: await compagnon(surPiece.id) } });
    await prisma.paymentPiece.create({ data: { requestId: await compagnon(surPiece.id), documentId: docPiece.id, kind: "INVOICE" } });
    const reg = async (k: string, statut: "ACTIVE" | "CANCELLED", avecPiece: boolean) => {
      const l = await prisma.legalDocument.create({ data: { title: `${TAG}reg-${k}`, kind: "INVOICE", status: statut, sourceType: "SPONSORING", sourceId: `${TAG}src-${k}` } });
      if (avecPiece) await doc("LEGAL_DOCUMENT", l.id);
    };
    await reg("registre", "ACTIVE", true);
    await reg("sanspiece", "ACTIVE", false);
    await reg("annule", "CANCELLED", true);

    const tous = [surOrdre, surSource, surPoste, surDossier, surPiece, auRegistre, registreSansPiece, registreAnnule, sansRien];
    const vus = await ordresAvecFacture(tous.map((o) => ({ id: o.id, sourceType: o.sourceType, sourceId: o.sourceId })));
    for (const o of [surOrdre, surSource, surPoste, surDossier, surPiece, auRegistre]) expect(vus.has(o.id), o.label).toBe(true);
    for (const o of [registreSansPiece, registreAnnule, sansRien]) expect(vus.has(o.id), o.label).toBe(false);
  });

  it("POINT D'APPEL : le règlement, l'écran et l'intelligence financière lisent la MÊME règle", () => {
    const sans = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(sans("src/lib/actions/expense-actions.ts")).toMatch(/await ordreAFacture\(\{ id: order\.id, sourceType: order\.sourceType, sourceId: order\.sourceId \}\)/);
    expect(sans("src/app/(app)/finances/paiements-a-faire/page.tsx")).toMatch(/await ordresAvecFacture\(/);
    expect(sans("src/platform/in-process/intelligence/index.ts")).toMatch(/await ordresAvecFacture\(/);
    // … et plus aucun d'eux ne compte les factures à sa façon.
    expect(sans("src/lib/actions/expense-actions.ts")).not.toMatch(/category: "INVOICE"/);
    expect(sans("src/app/(app)/finances/paiements-a-faire/page.tsx")).not.toMatch(/category: "INVOICE"/);
  });

  it("POINT D'APPEL : la fiche Legal montre « Renvoyer au règlement » quand l'ordre est clos", () => {
    const carte = readFileSync("src/app/(app)/legal/[id]/chain-card.tsx", "utf8");
    expect(carte).toMatch(/\(!settlement \|\| ordreClos\(settlement\)\)/);
    expect(carte).toMatch(/renvoi=\{Boolean\(settlement\)\}/);
  });
});
