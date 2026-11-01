import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));
// Le dépôt de fichier passe par le stockage objet en production : ici on teste l'ANNULATION, pas le stockage. Le faux
// rend un `documentId` réel (une ligne `Document`), que le nettoyage retrouve par son nom.
vi.mock("@/lib/documents", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  persistUploadedDocument: async () => {
    const doc = await (await import("@/lib/prisma")).prisma.document.create({
      data: { name: "__k10a_dem__piece.pdf", entityType: "PAYMENT_REQUEST", entityId: "x", fileKey: "k", mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
    });
    return { ok: true, documentId: doc.id };
  },
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { retablirGeste } from "@/lib/effets/retablissement";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import {
  addPaymentPiece, cancelPaymentRequest, commentPaymentPiece, corrigerDemandePaiement, createPaymentRequest, decidePaymentRequest,
  nudgePaymentRequest, reviewPaymentPiece, submitPaymentRequest, updatePaymentRequestDetails,
} from "./actions-demandes";
import { decidePayment, respondToPaymentCentre } from "./actions-centre";
import { grantPaymentCentreSeat, revokePaymentCentreSeat } from "./actions-sieges";
import { purgeSettledExpenseOrders } from "./actions-depenses";
import { createInvoice, setInvoicePaid, updateInvoice } from "@/lib/actions/invoice-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__k10a_dem__";
const RUN = `${TAG}${Date.now().toString(36)}`;

/** Les effets que l'annulation n'a pas pu défaire — hors la notification poussée déjà partie (effet sortant, K10b). */
const bloquants = (c: CompteRenduAnnulation) => c.details.filter((d) => d.issue === "IMPOSSIBLE" && !/^notification poussée/.test(d.quoi)).map((d) => `${d.quoi} : ${d.pourquoi}`);

function form(champs: Record<string, string>, pieces: { kind: string }[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  pieces.forEach((p, i) => {
    f.append("files", new File(["x"], `piece-${i}.pdf`, { type: "application/pdf" }));
    f.set(`kind_${i}`, p.kind);
  });
  return f;
}
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error ?? "");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEMANDES DE PAIEMENT, LE CENTRE, SES SIÈGES ET LES FACTURES SE DÉFONT D'UN GESTE (lot K10a, décision 0041).
 *
 * Même banc que `reversibilite-argent-flow.test.ts` : chaque cas EXÉCUTE l'action par son vrai point d'entrée (une
 * vraie personne, la base locale), l'ANNULE par l'annulation J7 et relit l'état. Séparation des tâches respectée :
 * le demandeur (délégué) n'est ni le centre (Direction) ni les Finances.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("K10a — demandes de paiement, centre, sièges, factures : exécuter puis annuler", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = { req: "MEDICAL_DELEGATE", fin: "FINANCE_BUDGET_MANAGER", dir: "DIRECTION", sa: "SUPER_ADMIN", siege: "VIEWER" };
  const demandes: string[] = [];
  const comme = async (k: string) => {
    const x = await prisma.user.findUniqueOrThrow({ where: { id: u[k]! } });
    ACTOR = { id: x.id, name: x.name, email: x.email, role: roles[k]!, access: await getAccess(x.id, roles[k]!), mustChangePassword: false };
  };
  const dernierGeste = async () => (await prisma.assistantGesteJournal.findFirst({ where: { principalId: ACTOR!.id, origine: "ecran", annuleLe: null }, orderBy: { creeLe: "desc" }, include: { effets: true } }))!;
  const annulerDernier = async (): Promise<CompteRenduAnnulation> => {
    const g = await dernierGeste();
    const r = await annulerGeste(g.id, ACTOR!);
    if ("refus" in r) throw new Error(r.refus);
    return r;
  };
  const demande = (id: string) => prisma.paymentRequest.findUniqueOrThrow({ where: { id } });

  /** Une demande déposée par le délégué : brouillon, ou transmise (facture + moyen de paiement → un ordre au centre). */
  // Un DEVIS justifie le dossier sans lecture de facture par Luna (aucun appel réseau dans le banc).
  async function nouvelle(titre: string, transmise: boolean): Promise<string> {
    await comme("req");
    const r = await createPaymentRequest(undefined, form({
      title: `${TAG}${titre}`, payee: "SARL Atlas", amount: "500000", submit: transmise ? "1" : "0", paymentMethodStated: "on", dueDate: "2026-11-15",
    }, [{ kind: "QUOTE" }]));
    expect(err(r)).toBeNull();
    demandes.push(r.id!);
    return r.id!;
  }

  beforeAll(async () => {
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${RUN} ${k}`, email: `${RUN}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => {});
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: { in: demandes } }, { reference: { startsWith: TAG } }] }, select: { id: true } })).map((o) => o.id);
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: `${TAG}OD${RUN.slice(-5)}-` } } }).catch(() => {});
    const factures = (await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, settlementTxId: true } }));
    await prisma.legalDocument.updateMany({ where: { id: { in: factures.map((f) => f.id) } }, data: { settlementTxId: null } }).catch(() => {});
    const ecritures = (await prisma.financeTransaction.findMany({ where: { OR: [{ createdById: { in: ids } }, { label: { contains: TAG } }] }, select: { id: true } })).map((t) => t.id);
    await prisma.financeTransaction.updateMany({ where: { id: { in: ecritures } }, data: { compensationDeId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ecritures } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: factures.map((f) => f.id) } } }).catch(() => {});
    await prisma.paymentCentreSeat.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: `${TAG}piece.pdf` } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  it("CRÉER une demande (brouillon) → retirée ; PRÉCISER puis CORRIGER → valeurs d'avant remises", async () => {
    const id = await nouvelle("Brouillon", false);
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect(await prisma.paymentRequest.findUnique({ where: { id } })).toBeNull();

    const id2 = await nouvelle("Préciser", false);
    expect(err(await updatePaymentRequestDetails(form({ id: id2, contactName: "M. Atlas", contactPhone: "0550", paymentMethodStated: "on" })))).toBeNull();
    expect((await demande(id2)).contactName).toBe("M. Atlas");
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await demande(id2)).contactName).toBeNull();

    expect(err(await corrigerDemandePaiement(form({ id: id2, amount: "450000", payee: "EURL Ziryab" })))).toBeNull();
    expect(Number((await demande(id2)).amount)).toBe(450_000);
    expect(bloquants(await annulerDernier())).toEqual([]);
    const d = await demande(id2);
    expect([Number(d.amount), d.payee]).toEqual([500_000, "SARL Atlas"]);
    expect(await prisma.paymentRequestEvent.count({ where: { requestId: id2, kind: "CORRECTED" } })).toBe(0);
  });

  it("PIÈCES : commenter → remis ; ajouter une pièce → retirée ; examiner (Finances) → verdict d'avant", async () => {
    const id = await nouvelle("Pièces", false);
    const piece = await prisma.paymentPiece.findFirstOrThrow({ where: { requestId: id } });
    expect(err(await commentPaymentPiece(form({ pieceId: piece.id, note: "facture définitive" })))).toBeNull();
    expect((await prisma.paymentPiece.findUniqueOrThrow({ where: { id: piece.id } })).note).toBe("facture définitive");
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.paymentPiece.findUniqueOrThrow({ where: { id: piece.id } })).note).toBe(piece.note);

    const f = form({ requestId: id, kind: "QUOTE" });
    f.set("file", new File(["y"], "devis.pdf", { type: "application/pdf" }));
    expect(err(await addPaymentPiece(f))).toBeNull();
    expect(await prisma.paymentPiece.count({ where: { requestId: id } })).toBe(2);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.paymentPiece.count({ where: { requestId: id } })).toBe(1);

    // L'examen se fait sur un dossier TRANSMIS (un brouillon ne s'examine pas).
    const t = await nouvelle("Examen", true);
    const p = await prisma.paymentPiece.findFirstOrThrow({ where: { requestId: t } });
    await comme("fin");
    expect(err(await reviewPaymentPiece(form({ pieceId: p.id, verdict: "CHANGES_REQUESTED", note: "illisible" })))).toBeNull();
    expect((await prisma.paymentPiece.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("CHANGES_REQUESTED");
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect((await prisma.paymentPiece.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(p.status);
    expect((await demande(t)).status).toBe("SUBMITTED");
  });

  it("TRANSMETTRE un brouillon → l'ordre né au centre est retiré et la demande redevient brouillon ; RÉTABLIR la retransmet", async () => {
    const id = await nouvelle("Transmettre", false);
    expect(err(await submitPaymentRequest(form({ id })))).toBeNull();
    const transmise = await demande(id);
    expect([transmise.status, !!transmise.expenseOrderId]).toEqual(["SUBMITTED", true]);
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    const brouillon = await demande(id);
    expect([brouillon.status, brouillon.expenseOrderId, brouillon.submittedAt]).toEqual(["DRAFT", null, null]);
    expect(await prisma.expenseOrder.findUnique({ where: { id: transmise.expenseOrderId! } })).toBeNull();

    // RÉTABLIR : l'annulation se défait — la demande est de nouveau transmise, son ordre recréé (même identifiant).
    const r = await retablirGeste(c.gesteId, ACTOR!);
    expect("refus" in r ? r.refus : bloquants(r)).toEqual([]);
    const retablie = await demande(id);
    expect([retablie.status, retablie.expenseOrderId]).toEqual(["SUBMITTED", transmise.expenseOrderId]);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: transmise.expenseOrderId! } })).status).toBe("PENDING");
  });

  it("DÉCIDER (Finances, renvoi au demandeur) puis RELANCER → chaque geste se remet ; RETIRER → demande et ordre rouverts", async () => {
    const id = await nouvelle("Décider", true);
    await comme("fin");
    expect(err(await decidePaymentRequest(form({ id, move: "REQUEST_CHANGES", note: "la facture diffère" })))).toBeNull();
    expect((await demande(id)).status).not.toBe("SUBMITTED");
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await demande(id)).status).toBe("SUBMITTED");

    await comme("req");
    expect(err(await nudgePaymentRequest(form({ id, kind: "URGENT", comment: "fournisseur bloque la livraison" })))).toBeNull();
    expect((await demande(id)).urgency).toBe("URGENT");
    const relance = await annulerDernier();
    expect(bloquants(relance)).toEqual([]);
    expect((await demande(id)).urgency).not.toBe("URGENT");
    expect(await prisma.paymentRequestEvent.count({ where: { requestId: id, kind: "URGENT" } })).toBe(0);

    const ordreId = (await demande(id)).expenseOrderId!;
    expect(err(await cancelPaymentRequest(form({ id, note: "plus nécessaire" })))).toBeNull();
    expect([(await demande(id)).status, (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status]).toEqual(["CANCELLED", "CANCELLED"]);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect([(await demande(id)).status, (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status]).toEqual(["SUBMITTED", "PENDING"]);
  });

  it("LE CENTRE : autoriser → l'ordre revient en attente ; répondre au centre → la question revient au demandeur", async () => {
    const id = await nouvelle("Centre", true);
    const ordreId = (await demande(id)).expenseOrderId!;
    await comme("dir");
    expect(err(await decidePayment(form({ id: ordreId, decision: "APPROVE" })))).toBeNull();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).centralStatus).toBe("APPROVED");
    expect(bloquants(await annulerDernier())).toEqual([]);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } });
    expect([o.centralStatus, o.centralDecidedById]).toEqual(["AWAITING", null]);

    // Le centre demande une précision (posée en base : c'est la RÉPONSE qu'on éprouve), le demandeur répond.
    await prisma.expenseOrder.update({ where: { id: ordreId }, data: { centralStatus: "INFO_REQUESTED" } });
    await comme("req");
    expect(err(await respondToPaymentCentre(form({ id: ordreId, body: "le devis est joint au dossier" })))).toBeNull();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).centralStatus).toBe("AWAITING");
    const messages = await prisma.paymentCentreMessage.count({ where: { orderId: ordreId } });
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).centralStatus).toBe("INFO_REQUESTED");
    expect(await prisma.paymentCentreMessage.count({ where: { orderId: ordreId } })).toBe(messages - 1);
  });

  it("CASCADE : annuler la création d'une demande dont l'ordre a été autorisé DEPUIS → rien n'est effacé en silence, l'ordre ne reste pas payable", async () => {
    const id = await nouvelle("Cascade", true);
    const creation = await dernierGeste();
    const ordreId = (await demande(id)).expenseOrderId!;
    await comme("dir");
    expect(err(await decidePayment(form({ id: ordreId, decision: "APPROVE" })))).toBeNull();
    await comme("req");
    const r = await annulerGeste(creation.id, ACTOR!);
    if ("refus" in r) throw new Error(r.refus);
    // L'ordre a été touché par le centre depuis : il n'est pas retiré, il est COMPENSÉ (annulé, la trace reste).
    const ordre = r.details.find((d) => /ordre de dépense/.test(d.quoi) && /créé/.test(d.quoi));
    expect(ordre?.issue, JSON.stringify(r.details)).toBe("COMPENSE");
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } });
    expect(o.status).toBe("CANCELLED");
    // Et la demande ne reste pas « transmise » au-dessus d'un ordre annulé : elle est retirée ou close.
    const d = await prisma.paymentRequest.findUnique({ where: { id } });
    expect(d === null || d.status === "CANCELLED", JSON.stringify(r.details)).toBe(true);
  });

  it("SIÈGES : accorder → retiré ; retirer → recréé à l'identique", async () => {
    await comme("sa");
    expect(err(await grantPaymentCentreSeat(form({ userId: u.siege!, note: "intérim de la Direction" })))).toBeNull();
    const siege = await prisma.paymentCentreSeat.findFirstOrThrow({ where: { userId: u.siege! } });
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.paymentCentreSeat.findUnique({ where: { id: siege.id } })).toBeNull();

    expect(err(await grantPaymentCentreSeat(form({ userId: u.siege!, note: "intérim de la Direction" })))).toBeNull();
    const s2 = await prisma.paymentCentreSeat.findFirstOrThrow({ where: { userId: u.siege! } });
    expect(err(await revokePaymentCentreSeat(form({ userId: u.siege!, note: "fin d'intérim" })))).toBeNull();
    expect(await prisma.paymentCentreSeat.findUnique({ where: { id: s2.id } })).toBeNull();
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.paymentCentreSeat.findUniqueOrThrow({ where: { id: s2.id } })).note).toBe(s2.note);
  });

  it("MASQUER les ordres réglés de l'historique → les ordres masqués par ce geste réapparaissent, même au-delà de 500", async () => {
    // Un historique PLUS LONG que ce que le journal détaille d'un seul `updateMany` (500) : la purge procède par
    // tranches nommées, chaque ordre est journalisé, et TOUS réapparaissent.
    await prisma.expenseOrder.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        reference: `${TAG}OD${RUN.slice(-5)}-${i}`, label: `${TAG} réglé ${i}`, amount: 1_000, category: "AUTRE" as const, status: "PAID" as const,
        centralStatus: "APPROVED", requestedById: u.req,
      })),
    });
    const nos = { reference: { startsWith: `${TAG}OD${RUN.slice(-5)}-` } };
    await comme("sa");
    expect(err(await purgeSettledExpenseOrders())).toBeNull();
    expect(await prisma.expenseOrder.count({ where: { ...nos, historiqueMasqueLe: null } })).toBe(0);
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect(await prisma.expenseOrder.count({ where: { ...nos, historiqueMasqueLe: null } })).toBe(520);
  });

  it("FACTURES : enregistrer → ANNULÉE (pièce numérotée, jamais retirée — règle K10b) ; modifier → remise ; marquer payée → date retirée, le décaissement reste et un « à récupérer » le compense", async () => {
    await comme("sa");
    const c = await createInvoice(undefined, form({ title: `${TAG}Facture Atlas`, number: `${RUN}-F1`, amount: "80000", direction: "OUT", counterparty: "SARL Atlas" }));
    expect(err(c)).toBeNull();
    expect(bloquants(await annulerDernier())).toEqual([]);
    // Une facture est une PIÈCE NUMÉROTÉE (K10b, `MODELES_PIECES_NUMEROTEES`) : annulée, elle reste, avec ses fichiers.
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: c.id! } })).status).toBe("CANCELLED");

    const f = await createInvoice(undefined, form({ title: `${TAG}Facture Ziryab`, number: `${RUN}-F2`, amount: "60000", direction: "OUT", counterparty: "EURL Ziryab" }));
    expect(err(f)).toBeNull();
    expect(err(await updateInvoice(form({ id: f.id!, title: `${TAG}Facture Ziryab corrigée`, number: `${RUN}-F2`, amount: "65000", direction: "OUT", counterparty: "EURL Ziryab" })))).toBeNull();
    expect(bloquants(await annulerDernier())).toEqual([]);
    const remise = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id! } });
    expect([remise.title, Number(remise.amount)]).toEqual([`${TAG}Facture Ziryab`, 60_000]);

    expect(err(await setInvoicePaid({ id: f.id!, paidDate: "2026-10-30" }))).toBeNull();
    const payee = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id! } });
    expect(payee.paidDate).not.toBeNull();
    const reglement = payee.settlementTxId;
    const r = await annulerDernier();
    expect(bloquants(r)).toEqual([]);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id! } });
    expect([apres.paidDate, apres.settlementTxId]).toEqual([null, null]);
    if (reglement) {
      expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: reglement } })).status).toBe("SETTLED");
      const ar = await prisma.financeTransaction.findFirstOrThrow({ where: { compensationDeId: reglement } });
      expect(ar.compensation).toBe(ar.direction === "IN" && ar.status === "PENDING" ? "A_RECUPERER" : "CONTRE_PASSATION");
    }
  });
});
