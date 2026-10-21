import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getUser: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR,
}));

/**
 * CE QUE « LUNA » LIT SUR CHAQUE FACTURE, par nom de fichier (`null` = lecture impossible). Aucun fournisseur d'IA
 * n'est appelé : la garde des doublons (`verifierFacturesAvantDepot`) et la lecture gardée (`ttcDesFacturesStockees`)
 * rendent ce TTC ; tout le reste — la règle, les actions, l'ordre, le centre — est le code de production.
 */
const LUES = vi.hoisted(() => new Map<string, number | null>());

// Le dépôt de fichier passe par le stockage en production : ici, un `Document` réel nommé d'après le fichier.
vi.mock("@/lib/documents", () => ({
  persistUploadedDocument: async (_u: string, o: { entityId: string; file: File }) => {
    const doc = await (await import("@/lib/prisma")).prisma.document.create({
      data: {
        name: `__paymontant__${o.file.name}`, entityType: "PAYMENT_REQUEST", entityId: o.entityId, fileKey: `__paymontant__${o.file.name}`,
        mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL",
      },
    });
    return { ok: true, documentId: doc.id };
  },
}));

vi.mock("@/lib/factures/connues", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/factures/connues")>();
  const { IDENTITE_FACTURE_VIDE } = await import("@/lib/factures/identite");
  const { prisma: db } = await import("@/lib/prisma");
  return {
    ...vrai,
    verifierFacturesAvantDepot: async (_u: unknown, fichiers: readonly { nom: string }[]) => ({
      ok: true, probables: [], identites: fichiers.map((f) => ({ ...IDENTITE_FACTURE_VIDE, ttc: LUES.get(f.nom) ?? null })),
    }),
    ttcDesFacturesStockees: async (ids: readonly string[]) => {
      const docs = await db.document.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
      return new Map(docs.map((d) => [d.id, LUES.get(d.name.replace("__paymontant__", "")) ?? null]));
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  createPaymentRequest, submitPaymentRequest, addPaymentPiece, corrigerDemandePaiement, decidePaymentRequest,
  cancelPaymentRequest, supprimerDemandePaiement,
} from "./payment-request-actions";
import { decidePayment, respondToPaymentCentre } from "./payment-centre-actions";
import { apercuDeSuppression, restoreDeletedRecord } from "./admin-delete-actions";
import { chargerCentre } from "@/lib/queries/centre-paiement";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__paymontant__";
const lisible = (s: string | null | undefined) => (s ?? "").replace(/[   ]/g, " ");

function fd(fields: Record<string, string>, fichiers: Record<string, File> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const [k, v] of Object.entries(fichiers)) f.set(k, v);
  return f;
}
const fichier = (nom: string) => new File(["x"], nom, { type: "application/pdf" });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX DÉFAUTS DES DEMANDES DE PAIEMENT (Direction, 19/10/2026), par les VRAIS points d'entrée.
 *
 *   1. MONTANT DIVERGENT — la demande déposée depuis « Demandes de validations » partait au centre sous le montant SAISI,
 *      jamais confronté au TTC de la facture que Luna venait pourtant de lire. Chaque cas ci-dessous porte son témoin.
 *   2. RETRAIT — la demande retirée restait listée, comptée et autorisable au centre (son ordre annulé gardait une
 *      autorisation « en attente ») ; et rien ne permettait de la supprimer.
 *
 * Le demandeur est un délégué médical, sans vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Demande de paiement — le montant est celui de la facture ; retirée, elle quitte le centre", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = { req: "MEDICAL_DELEGATE", autre: "MEDICAL_DELEGATE", fin: "FINANCE_BUDGET_MANAGER", dir: "DIRECTION", sa: "SUPER_ADMIN" };
  let A = "";
  const comme = async (k: string) => {
    const x = await prisma.user.findUniqueOrThrow({ where: { id: u[k] } });
    ACTOR = { id: x.id, name: x.name, email: x.email, role: roles[k]!, access: await getAccess(x.id, roles[k]!), mustChangePassword: false } as CurrentUser;
  };

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const demandes = (await prisma.paymentRequest.findMany({ where: { OR: [{ title: { startsWith: TAG } }, { requesterId: { in: comptes } }] }, select: { id: true } })).map((d) => d.id);
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: { in: demandes } }, { label: { contains: TAG } }, { requestedById: { in: comptes } }] }, select: { id: true } })).map((o) => o.id);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    A = (await prisma.company.create({ data: { name: `${TAG}Alpha` } })).id;
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
      await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId: A, userId: u[k] } });
    }
  }, 60_000);

  afterAll(async () => { await nettoyer(); }, 60_000);

  /** « Demander un paiement » depuis Demandes de validations : objet, bénéficiaire, montant, pièces, moyen de paiement. */
  async function deposer(titre: string, montant: number, pieces: { nom: string; kind: string; ttc?: number | null }[], extra: Record<string, string> = {}) {
    await comme("req");
    const f = fd({ title: `${TAG}${titre}`, payee: "SARL Atlas", amount: String(montant), submit: "1", paymentMethodStated: "on", ...extra });
    pieces.forEach((p, i) => {
      if (p.ttc !== undefined) LUES.set(p.nom, p.ttc);
      f.append("files", fichier(p.nom));
      f.set(`kind_${i}`, p.kind);
    });
    return createPaymentRequest(undefined, f);
  }
  const demande = (id: string) => prisma.paymentRequest.findUniqueOrThrow({ where: { id }, select: { amount: true, status: true, expenseOrderId: true } });
  const ordre = (id: string) => prisma.expenseOrder.findUniqueOrThrow({ where: { id }, select: { amount: true, notes: true, status: true, centralStatus: true } });
  const evenements = (id: string, kind: string) => prisma.paymentRequestEvent.findMany({ where: { requestId: id, kind }, select: { message: true } });
  const parTitre = (titre: string) => prisma.paymentRequest.count({ where: { title: `${TAG}${titre}` } });

  // ───────────────────────────── 1. LE MONTANT ─────────────────────────────

  it("facture = montant demandé → la demande part, et l'ordre au centre porte le montant de la facture", async () => {
    const r = await deposer("egal", 119_000, [{ nom: "egal.pdf", kind: "INVOICE", ttc: 119_000 }]);
    expect(r.ok, r.error).toBe(true);
    const d = await demande(r.id!);
    expect(Number((await ordre(d.expenseOrderId!)).amount)).toBe(119_000);
    expect(await evenements(r.id!, "ECART_ASSUME")).toHaveLength(0);
  });

  it("LE DÉFAUT : le HT tapé pour une facture TTC → refusé, les deux chiffres rendus à l'écran, RIEN n'est créé", async () => {
    const r = await deposer("ht", 100_000, [{ nom: "ht.pdf", kind: "INVOICE", ttc: 119_000 }]);
    expect(r.ok).toBe(false);
    expect(r.ecartMontant).toEqual({ montant: 100_000, total: 119_000 });
    expect(lisible(r.error)).toContain("la facture fait 119 000 DZD TTC");
    expect(await parTitre("ht"), "un refus ne laisse ni demande ni ordre derrière lui").toBe(0);
  });

  it("facture < BC : le montant du BC est refusé, celui de la facture passe — le BC n'est pas la pièce qui se paie", async () => {
    const pieces = [{ nom: "bc-a.pdf", kind: "PURCHASE_ORDER" }, { nom: "fact-a.pdf", kind: "INVOICE", ttc: 80_000 }];
    const refus = await deposer("bc-plus-grand", 100_000, pieces);
    expect(refus.ecartMontant).toEqual({ montant: 100_000, total: 80_000 });
    const r = await deposer("facture-plus-petite", 80_000, pieces);
    expect(r.ok, r.error).toBe(true);
    expect(Number((await ordre((await demande(r.id!)).expenseOrderId!)).amount)).toBe(80_000);
  });

  it("facture > BC : refusé sans explication ; expliqué sans la case, refusé ; expliqué ET confirmé, l'écart part ÉCRIT dans l'ordre", async () => {
    const pieces = [{ nom: "bc-b.pdf", kind: "PURCHASE_ORDER" }, { nom: "fact-b.pdf", kind: "INVOICE", ttc: 120_000 }];
    expect((await deposer("plus-grande", 100_000, pieces)).ecartMontant).toEqual({ montant: 100_000, total: 120_000 });
    const sansCase = await deposer("plus-grande", 100_000, pieces, { ecartJustification: "acompte de 100 000 convenu" });
    expect(sansCase.ok).toBe(false);
    expect(sansCase.error).toContain("Oui, je confirme ce montant");
    expect(await parTitre("plus-grande")).toBe(0);

    const r = await deposer("plus-grande", 100_000, pieces, { ecartJustification: "acompte de 100 000 convenu", ecartConfirme: "1" });
    expect(r.ok, r.error).toBe(true);
    const o = await ordre((await demande(r.id!)).expenseOrderId!);
    expect(Number(o.amount)).toBe(100_000);
    expect(lisible(o.notes), "le centre lit l'écart et sa raison sur l'ordre qu'il autorise").toContain("ÉCART ASSUMÉ par le demandeur : Montant demandé 100 000 DZD, la facture fait 120 000 DZD TTC");
    expect(o.notes).toContain("acompte de 100 000 convenu");
    expect(await evenements(r.id!, "ECART_ASSUME")).toHaveLength(1);
  });

  it("plusieurs factures sur un BC : leurs TTC s'additionnent", async () => {
    const pieces = [{ nom: "p1.pdf", kind: "INVOICE", ttc: 60_000 }, { nom: "p2.pdf", kind: "INVOICE", ttc: 40_000 }];
    expect((await deposer("une-seule-comptee", 60_000, pieces)).ecartMontant).toEqual({ montant: 60_000, total: 100_000 });
    const r = await deposer("deux-factures", 100_000, pieces);
    expect(r.ok, r.error).toBe(true);
  });

  it("montant lu vs saisi : un dinar de tolérance ; une facture illisible ne bloque pas mais le fil dit « non vérifié »", async () => {
    expect((await deposer("arrondi", 119_000, [{ nom: "arrondi.pdf", kind: "INVOICE", ttc: 119_000.4 }])).ok).toBe(true);
    const r = await deposer("illisible", 77_000, [{ nom: "illisible.pdf", kind: "INVOICE", ttc: null }]);
    expect(r.ok, r.error).toBe(true);
    expect(await evenements(r.id!, "MONTANT_NON_LU")).toHaveLength(1);
  });

  it("un BROUILLON n'est pas confronté ; sa TRANSMISSION l'est, avec les mêmes deux issues", async () => {
    await comme("req");
    LUES.set("brouillon.pdf", 50_000);
    const f = fd({ title: `${TAG}brouillon`, payee: "SARL Atlas", amount: "45000", submit: "0", paymentMethodStated: "on" });
    f.append("files", fichier("brouillon.pdf"));
    f.set("kind_0", "INVOICE");
    const cree = await createPaymentRequest(undefined, f);
    expect(cree.ok, cree.error).toBe(true);
    const id = cree.id!;

    const refus = await submitPaymentRequest(fd({ id }));
    expect(refus.ok).toBe(false);
    expect(refus.ecartMontant).toEqual({ montant: 45_000, total: 50_000 });
    expect((await demande(id)).status, "le refus ne transmet rien").toBe("DRAFT");

    const ok = await submitPaymentRequest(fd({ id, ecartJustification: "remise de 5 000 accordée", ecartConfirme: "1" }));
    expect(ok.ok, ok.error).toBe(true);
    const d = await demande(id);
    expect(d.status).toBe("SUBMITTED");
    expect((await ordre(d.expenseOrderId!)).notes).toContain("remise de 5 000 accordée");
  });

  it("FACTURE REMPLACÉE : la nouvelle dit son écart, l'ancienne ne compte plus, et la retransmission attend le bon montant", async () => {
    const r = await deposer("remplacee", 50_000, [{ nom: "v1.pdf", kind: "INVOICE", ttc: 50_000 }]);
    expect(r.ok, r.error).toBe(true);
    const id = r.id!;
    await comme("fin");
    expect((await decidePaymentRequest(fd({ id, move: "REQUEST_CHANGES", note: "la facture définitive diffère" }))).ok).toBe(true);

    await comme("req");
    const v1 = await prisma.paymentPiece.findFirstOrThrow({ where: { requestId: id, kind: "INVOICE" }, select: { id: true } });
    LUES.set("v2.pdf", 55_000);
    const ajout = await addPaymentPiece(fd({ requestId: id, kind: "INVOICE", replacesId: v1.id }, { file: fichier("v2.pdf") }));
    expect(ajout.ok, ajout.error).toBe(true);
    expect(lisible(ajout.avertissement), "l'écart se dit au déposant").toContain("la facture fait 55 000 DZD TTC");
    expect(await evenements(id, "ECART_MONTANT")).toHaveLength(1);

    // La facture v1 remplacée ne compte plus : l'écart est 50 000 / 55 000, pas 50 000 / 105 000.
    const refus = await submitPaymentRequest(fd({ id }));
    expect(refus.ecartMontant).toEqual({ montant: 50_000, total: 55_000 });

    const corr = await corrigerDemandePaiement(fd({ id, amount: "55000", note: "facture définitive à 55 000" }));
    expect(corr.ok, corr.error).toBe(true);
    expect(corr.avertissement, "corrigé au montant de la facture : plus d'écart à dire").toBeUndefined();
    const ok = await submitPaymentRequest(fd({ id }));
    expect(ok.ok, ok.error).toBe(true);
    expect(Number((await ordre((await demande(id)).expenseOrderId!)).amount), "l'ordre au centre suit la correction").toBe(55_000);
  });

  it("LE TÉMOIN de la correction : un montant corrigé qui s'écarte de la facture se dit, dans le fil et à l'écran", async () => {
    const r = await deposer("corrige-a-cote", 30_000, [{ nom: "cac.pdf", kind: "INVOICE", ttc: 30_000 }]);
    await comme("fin");
    await decidePaymentRequest(fd({ id: r.id!, move: "REQUEST_CHANGES", note: "à revoir" }));
    await comme("req");
    const corr = await corrigerDemandePaiement(fd({ id: r.id!, amount: "35000", note: "frais de port ajoutés" }));
    expect(corr.ok, corr.error).toBe(true);
    expect(lisible(corr.avertissement)).toContain("la facture fait 30 000 DZD TTC");
    expect(lisible((await evenements(r.id!, "ECART_MONTANT"))[0]?.message)).toContain("frais de port ajoutés");
  });

  // ───────────────────────────── 2. LE RETRAIT ─────────────────────────────

  /** Une demande transmise, rangée dans la société de test pour lire le centre sans les données des autres. */
  async function transmiseDansA(titre: string) {
    const r = await deposer(titre, 10_000, [{ nom: `${titre}.pdf`, kind: "INVOICE", ttc: 10_000 }]);
    expect(r.ok, r.error).toBe(true);
    const d = await demande(r.id!);
    await prisma.paymentRequest.update({ where: { id: r.id! }, data: { companyId: A } });
    await prisma.expenseOrder.update({ where: { id: d.expenseOrderId! }, data: { companyId: A } });
    return { id: r.id!, orderId: d.expenseOrderId! };
  }
  const auCentre = async () => {
    await comme("sa");
    const c = await chargerCentre(ACTOR as unknown as SessionUser, { entite: A });
    const e = c.entites.find((x) => x.cle === A);
    return { total: e?.total ?? 0, enAttente: e?.enAttente ?? 0, montant: e?.montantEnAttente ?? 0, ids: c.idsAffiches };
  };

  it("RETIRÉE, la demande quitte le centre : plus listée, plus comptée — et son témoin, transmise, y est", async () => {
    const vivante = await transmiseDansA("temoin-centre");
    const retiree = await transmiseDansA("retiree-centre");
    const avant = await auCentre();
    expect(avant.ids).toEqual(expect.arrayContaining([vivante.orderId, retiree.orderId]));

    await comme("req");
    expect((await cancelPaymentRequest(fd({ id: retiree.id }))).ok).toBe(true);
    expect((await ordre(retiree.orderId)).status).toBe("CANCELLED");

    const apres = await auCentre();
    expect(apres.ids, "l'ordre annulé n'est plus listé").not.toContain(retiree.orderId);
    expect(apres.ids, "le témoin reste").toContain(vivante.orderId);
    expect(apres.total).toBe(avant.total - 1);
    expect(apres.enAttente).toBe(avant.enAttente - 1);
    expect(apres.montant).toBe(avant.montant - 10_000);
  });

  it("RETIRÉE, elle n'est plus autorisable — ni par le centre, ni par une réponse du demandeur ; le témoin l'est", async () => {
    const vivante = await transmiseDansA("temoin-decision");
    const retiree = await transmiseDansA("retiree-decision");
    await comme("req");
    await cancelPaymentRequest(fd({ id: retiree.id }));

    await comme("dir");
    const refus = await decidePayment(fd({ id: retiree.orderId, decision: "APPROVE" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/a été annulé/);
    expect((await ordre(retiree.orderId)).centralStatus, "rien n'est écrit").toBe("AWAITING");

    await comme("req");
    const reponse = await respondToPaymentCentre(fd({ id: retiree.orderId, body: "voici l'argumentaire" }));
    expect(reponse.ok).toBe(false);
    expect(reponse.error).toMatch(/a été annulé/);

    await comme("dir");
    expect((await decidePayment(fd({ id: vivante.orderId, decision: "APPROVE" }))).ok).toBe(true);
    expect((await ordre(vivante.orderId)).centralStatus).toBe("APPROVED");
  });

  // ───────────────────────────── 3. LA SUPPRESSION ─────────────────────────────

  it("une demande VIVANTE ne se supprime pas (on la retire d'abord) ; un tiers ne supprime pas celle d'un autre", async () => {
    const d = await transmiseDansA("vivante-suppr");
    await comme("req");
    const r = await supprimerDemandePaiement(fd({ id: d.id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Retirez d'abord la demande/);

    await cancelPaymentRequest(fd({ id: d.id }));
    await comme("autre");
    const tiers = await supprimerDemandePaiement(fd({ id: d.id }));
    expect(tiers.ok).toBe(false);
    expect(tiers.error).toMatch(/Seul le demandeur/);
    expect(await prisma.paymentRequest.count({ where: { id: d.id } })).toBe(1);
  });

  it("RETIRÉE, elle se supprime définitivement — avec son ordre annulé, à la corbeille, auditée ; le Super Admin la restaure", async () => {
    const d = await transmiseDansA("a-supprimer");
    await comme("req");
    await cancelPaymentRequest(fd({ id: d.id }));

    const apercu = await apercuDeSuppression(fd({ kind: "PAYMENT_REQUEST", id: d.id }));
    expect("erreur" in apercu ? apercu.erreur : null).toBeNull();
    if (!("erreur" in apercu)) {
      expect(apercu.refus).toBeNull();
      expect(apercu.emporte.join(" ")).toMatch(/ordre de dépense/);
    }

    const r = await supprimerDemandePaiement(fd({ id: d.id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.redirect).toBe("/validations/paiements");
    expect(await prisma.paymentRequest.count({ where: { id: d.id } })).toBe(0);
    expect(await prisma.expenseOrder.count({ where: { id: d.orderId } }), "l'ordre annulé part avec elle").toBe(0);
    expect(await prisma.auditLog.count({ where: { actorId: u.req, action: "DELETE", entityId: d.id } })).toBe(1);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "PAYMENT_REQUEST", sourceId: d.id }, select: { id: true } });

    await comme("sa");
    const restauree = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(restauree.ok, restauree.error).toBe(true);
    expect((await demande(d.id)).status).toBe("CANCELLED");
    expect((await ordre(d.orderId)).status, "l'ordre revient annulé — il ne réapparaît pas au centre").toBe("CANCELLED");
    expect((await auCentre()).ids).not.toContain(d.orderId);
  }, 60_000); // l'inventaire du lot lit toutes les relations du schéma : lent sous charge, pas bloqué

  it("un paiement déjà SORTI interdit la suppression ; un brouillon se supprime", async () => {
    const d = await transmiseDansA("deja-paye");
    await prisma.expenseOrder.update({ where: { id: d.orderId }, data: { status: "PAID" } });
    await prisma.paymentRequest.update({ where: { id: d.id }, data: { status: "CANCELLED" } });
    await comme("req");
    const r = await supprimerDemandePaiement(fd({ id: d.id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà sorti/);
    expect(await prisma.paymentRequest.count({ where: { id: d.id } })).toBe(1);

    const brouillon = await createPaymentRequest(undefined, fd({ title: `${TAG}brouillon-suppr`, payee: "X", amount: "1000", submit: "0" }));
    expect(brouillon.ok, brouillon.error).toBe(true);
    expect((await supprimerDemandePaiement(fd({ id: brouillon.id! }))).ok).toBe(true);
    expect(await prisma.paymentRequest.count({ where: { id: brouillon.id! } })).toBe(0);
  });
});
