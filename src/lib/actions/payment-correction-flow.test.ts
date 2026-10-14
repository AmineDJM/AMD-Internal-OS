import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

// Le dépôt de fichier passe par S3 en production : ici on teste la RÈGLE, pas le stockage. Le faux
// rend un `documentId` réel, que le nettoyage retrouve par son nom.
vi.mock("@/lib/documents", () => ({
  persistUploadedDocument: async () => {
    const doc = await (await import("@/lib/prisma")).prisma.document.create({
      data: { name: "__paycorr__piece.pdf", entityType: "PAYMENT_REQUEST", entityId: "x", fileKey: "k", mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
    });
    return { ok: true, documentId: doc.id };
  },
}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import {
  createPaymentRequest, corrigerDemandePaiement, decidePaymentRequest, submitPaymentRequest,
  addPaymentPiece, reviewPaymentPiece,
} from "./payment-request-actions";
import { decidePayment } from "./payment-centre-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__paycorr__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

function form(fields: Record<string, string>, pieces: { kind: string }[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  pieces.forEach((p, i) => {
    fd.append("files", new File(["x"], `piece-${i}.pdf`, { type: "application/pdf" }));
    fd.set(`kind_${i}`, p.kind);
  });
  return fd;
}

const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error ?? "");

/**
 * CORRIGER SA DEMANDE DE PAIEMENT — par les VRAIS points d'entrée (§118.191, audit 360° R04).
 *
 * Le demandeur est un délégué médical : il crée des demandes de paiement SANS la vue globale — une
 * garde éprouvée avec la vue globale ne peut pas tomber (§118.104). Les témoins de concurrence sont
 * FORCÉS : la transaction qui tient le verrou SHARE attend que le geste soit bloqué entre sa lecture et
 * son écriture, écrit elle-même le changement concurrent, puis relâche (§118.187d).
 */
suite("Demande de paiement — se corrige chez son demandeur, et l'ordre suit au centre", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = { req: "MEDICAL_DELEGATE", coll: "MEDICAL_DELEGATE", fin: "FINANCE_BUDGET_MANAGER", dir: "DIRECTION" };
  const created: string[] = [];
  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!, roles[k]!); };

  beforeAll(async () => {
    for (const [k, role] of Object.entries(roles)) {
      const x = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } });
      u[k] = x.id;
    }
  });

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "PAYMENT_REQUEST", sourceId: { in: created } }, select: { id: true } });
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: created } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: `${TAG}piece.pdf` } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** Une demande déposée par le délégué : brouillon, ou transmise (facture + moyen de paiement). */
  async function nouvelle(titre: string, opts: { transmise?: boolean; montant?: number; payee?: string } = {}): Promise<string> {
    await comme("req");
    const r = await createPaymentRequest(undefined, form({
      title: `${TAG}${titre}`, payee: opts.payee ?? "SARL Atlas", amount: String(opts.montant ?? 500_000),
      submit: opts.transmise ? "1" : "0", paymentMethodStated: "on", dueDate: "2026-11-15",
    }, opts.transmise ? [{ kind: "INVOICE" }] : []));
    expect(r.ok, err(r) ?? "").toBe(true);
    created.push(r.id!);
    return r.id!;
  }

  /** Transmise, puis renvoyée par les Finances — le dossier revient au demandeur, l'ordre existe. */
  async function renvoyee(titre: string, opts: { autorisee?: boolean; montant?: number; payee?: string } = {}) {
    const id = await nouvelle(titre, { transmise: true, montant: opts.montant, payee: opts.payee });
    const req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id }, select: { expenseOrderId: true } });
    if (opts.autorisee) {
      await comme("dir");
      expect(err(await decidePayment(form({ id: req.expenseOrderId!, decision: "APPROVE" })))).toBeNull();
    }
    await comme("fin");
    expect(err(await decidePaymentRequest(form({ id, move: "REQUEST_CHANGES", note: "la facture définitive diffère" })))).toBeNull();
    return { id, orderId: req.expenseOrderId! };
  }

  const corriger = async (k: string, fields: Record<string, string>) => { await comme(k); return corrigerDemandePaiement(form(fields)); };
  const ordre = (id: string) => prisma.expenseOrder.findUniqueOrThrow({ where: { id }, select: { amount: true, beneficiary: true, label: true, centralStatus: true, centralDecidedById: true, dueDate: true, status: true, reference: true } });
  const demande = (id: string) => prisma.paymentRequest.findUniqueOrThrow({ where: { id }, select: { title: true, payee: true, amount: true, status: true, urgency: true, description: true, dueDate: true, companyId: true } });

  /** Un geste bloqué entre sa lecture et son écriture sur `table`, pendant qu'une autre transaction écrit. */
  async function pendantLaLecture<T>(table: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ${`%"${table}"%`}`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) throw new Error("le geste n'a pas atteint la barrière");
        await new Promise((r) => setTimeout(r, 25));
      }
      await concurrent(tx);
    }, { timeout: 20_000 });
    return geste;
  }

  it("PRÉMISSES : le demandeur et son collègue créent des demandes sans la vue globale ; la Direction siège au centre", async () => {
    for (const k of ["req", "coll"]) {
      const a = await actorFor(u[k]!, roles[k]!);
      expect(hasGlobalView(a.role), "une garde éprouvée avec la vue globale ne peut pas tomber (§118.104)").toBe(false);
      expect(userCan(a, "VALIDATIONS", "CREATE")).toBe(true);
    }
  });

  it("AU BROUILLON : le demandeur corrige objet, bénéficiaire, montant, urgence — sans motif ; un collègue, non", async () => {
    const id = await nouvelle("Brouillon");
    expect(err(await corriger("coll", { id, amount: "450000" }))).toBe("Seul le demandeur corrige sa demande.");
    const r = await corriger("req", { id, title: `${TAG}Brouillon corrigé`, payee: "EURL Ziryab", amount: "450000", urgency: "THIS_WEEK", companyId: "" });
    expect(err(r)).toBeNull();
    expect(r.message).toBe("Demande corrigée.");
    const d = await demande(id);
    expect(d).toMatchObject({ title: `${TAG}Brouillon corrigé`, payee: "EURL Ziryab", status: "DRAFT", urgency: "THIS_WEEK", companyId: null });
    expect(Number(d.amount)).toBe(450_000);
    const ev = await prisma.paymentRequestEvent.findFirstOrThrow({ where: { requestId: id, kind: "CORRECTED" } });
    expect(ev.message).toContain(`Montant : ${(500_000).toLocaleString("fr-FR")} DZD → ${(450_000).toLocaleString("fr-FR")} DZD`);
    expect(ev.message).toContain("Urgence : Dès que possible → Cette semaine");
  });

  it("CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c) — et rien de changé ne s'écrit pas non plus", async () => {
    const id = await nouvelle("Partiel");
    expect(err(await corriger("req", { id, amount: "420000" }))).toBeNull();
    const d = await demande(id);
    expect(d).toMatchObject({ title: `${TAG}Partiel`, payee: "SARL Atlas", description: null });
    expect(d.dueDate?.toISOString().slice(0, 10)).toBe("2026-11-15");
    const r = await corriger("req", { id, amount: "420000", payee: "SARL Atlas" });
    expect(r).toMatchObject({ ok: true, message: "Rien n'a changé : la demande est restée telle quelle." });
    expect(await prisma.paymentRequestEvent.count({ where: { requestId: id, kind: "CORRECTED" } })).toBe(1);
  });

  it("une valeur vide ou fausse est refusée, et une entité qui n'est pas la sienne aussi", async () => {
    const id = await nouvelle("Valeurs");
    expect(err(await corriger("req", { id, title: "" }))).toBe("L'objet du paiement ne peut pas être vide.");
    expect(err(await corriger("req", { id, payee: " " }))).toMatch(/Le bénéficiaire ne peut pas être vide/);
    expect(err(await corriger("req", { id, amount: "0" }))).toBe("Indiquez un montant positif.");
    expect(err(await corriger("req", { id, dueDate: "pas une date" }))).toBe("Échéance illisible.");
    // Une entité réelle, que le délégué n'a pas : sans elle, le cas ne mesurerait que la clé étrangère.
    const autre = await prisma.company.findFirst({ select: { id: true } });
    expect(autre, "décor : il faut une entité en base").not.toBeNull();
    expect(err(await corriger("req", { id, companyId: autre!.id }))).toMatch(/ne vous est pas ouverte/);
    expect(Number((await demande(id)).amount)).toBe(500_000);
  });

  it("CHEZ LES FINANCES, la demande ne bouge pas — l'état d'abord, avant même une valeur fausse", async () => {
    const id = await nouvelle("Transmise", { transmise: true });
    expect(err(await corriger("req", { id, amount: "0" }))).toMatch(/Le dossier est chez les Finances : il se corrige quand elles vous le renvoient/);
  });

  it("RENVOYÉE : ce qui a changé se dit ; l'entité et l'urgence ne se corrigent plus ; le motif après l'état", async () => {
    const { id } = await renvoyee("Motif");
    expect(err(await corriger("req", { id, amount: "450000" }))).toMatch(/Dites ce qui a changé/);
    expect(err(await corriger("req", { id, urgency: "URGENT", note: "x" }))).toMatch(/Signaler une urgence/);
    expect(err(await corriger("req", { id, companyId: "", note: "x" }))).toMatch(/L'entité ne change plus/);
    // L'état d'abord : un collègue reçoit le refus de la personne, pas celui du motif.
    expect(err(await corriger("coll", { id, amount: "450000" }))).toBe("Seul le demandeur corrige sa demande.");
  });

  it("RENVOYÉE, ordre EN ATTENTE du centre : la baisse suit l'ordre — montant, libellé, échéance — sans rien rouvrir", async () => {
    const { id, orderId } = await renvoyee("Attente");
    const r = await corriger("req", { id, amount: "450000", title: `${TAG}Attente corrigée`, dueDate: "2026-12-01", note: "facture définitive à 450 000" });
    expect(err(r)).toBeNull();
    expect(r.message).toBe("Demande corrigée — renvoyez-la aux Finances quand votre correction est complète.");
    const o = await ordre(orderId);
    expect(Number(o.amount)).toBe(450_000);
    expect(o.centralStatus).toBe("AWAITING");
    const { reference } = await prisma.paymentRequest.findUniqueOrThrow({ where: { id }, select: { reference: true } });
    expect(o.label, "le libellé de l'ordre suit l'objet corrigé").toBe(`${reference} — ${TAG}Attente corrigée`);
    expect(o.dueDate?.toISOString().slice(0, 10), "en attente du centre, l'échéance de l'ordre suit la demande").toBe("2026-12-01");
    expect((await demande(id)).status, "le demandeur garde son dossier jusqu'à ce qu'il le renvoie").toBe("CHANGES_REQUESTED");
  });

  it("RENVOYÉE, ordre AUTORISÉ : relever le montant rouvre le centre, avec la raison au fil et la Direction prévenue", async () => {
    const { id, orderId } = await renvoyee("Hausse", { autorisee: true });
    const r = await corriger("req", { id, amount: "600000", note: "frais de transport ajoutés par le fournisseur" });
    expect(err(r)).toBeNull();
    expect(r.message).toMatch(/repasse au centre de paiement/);
    const o = await ordre(orderId);
    expect(Number(o.amount)).toBe(600_000);
    expect(o.centralStatus).toBe("AWAITING");
    expect(o.centralDecidedById).toBeNull();
    const msg = await prisma.paymentCentreMessage.findFirstOrThrow({ where: { orderId, decision: null }, orderBy: { createdAt: "desc" } });
    expect(msg.body).toMatch(/^Montant relevé de .* à .* DZD après autorisation \(demande PAY-\d{4}-\d+ corrigée par son demandeur\) — l'autorisation est à redonner\.$/);
    const notifs = await prisma.notification.count({ where: { userId: u.dir, title: "Paiement à ré-autoriser — montant relevé", body: { contains: o.reference } } });
    expect(notifs).toBe(1);
  });

  it("RENVOYÉE, ordre AUTORISÉ : baisser ne rouvre rien ; l'échéance imposée par le centre ne bouge pas", async () => {
    const { id, orderId } = await renvoyee("Baisse", { autorisee: true });
    expect(err(await corriger("req", { id, amount: "400000", dueDate: "2026-12-20", note: "remise accordée" }))).toBeNull();
    const o = await ordre(orderId);
    expect(Number(o.amount)).toBe(400_000);
    expect(o.centralStatus).toBe("APPROVED");
    expect(o.dueDate?.toISOString().slice(0, 10), "autorisé, l'ordre garde sa date — le souhait du demandeur ne réécrit pas l'arbitrage").not.toBe("2026-12-20");
    expect((await demande(id)).dueDate?.toISOString().slice(0, 10)).toBe("2026-12-20");
  });

  it("RENVOYÉE, ordre AUTORISÉ : un AUTRE bénéficiaire rouvre le centre ; une coquille de casse, non", async () => {
    const { id, orderId } = await renvoyee("Bénéficiaire", { autorisee: true });
    expect(err(await corriger("req", { id, payee: "sarl  ATLAS", note: "casse" }))).toBeNull();
    expect((await ordre(orderId)).centralStatus).toBe("APPROVED");
    expect(err(await corriger("req", { id, payee: "EURL Ziryab", note: "le fournisseur a changé de raison sociale" }))).toBeNull();
    const o = await ordre(orderId);
    expect(o).toMatchObject({ centralStatus: "AWAITING", beneficiary: "EURL Ziryab" });
    const msg = await prisma.paymentCentreMessage.findFirstOrThrow({ where: { orderId, decision: null }, orderBy: { createdAt: "desc" } });
    expect(msg.body).toMatch(/^Bénéficiaire changé : « sarl {2}ATLAS » → « EURL Ziryab » après autorisation/);
  });

  it("l'argent parti ou refusé : la correction est refusée, et rien n'est écrit", async () => {
    const regle = await renvoyee("Réglé", { autorisee: true });
    await prisma.expenseOrder.update({ where: { id: regle.orderId }, data: { status: "PAID" } });
    expect(err(await corriger("req", { id: regle.id, amount: "1", note: "x" }))).toMatch(/déjà réglé/);
    expect(Number((await demande(regle.id)).amount)).toBe(500_000);

    const refuse = await renvoyee("Refusé");
    await comme("dir");
    expect(err(await decidePayment(form({ id: refuse.orderId, decision: "REFUSE", body: "budget épuisé" })))).toBeNull();
    expect(err(await corriger("req", { id: refuse.id, amount: "1", note: "x" }))).toMatch(/Le centre de paiement a refusé ce paiement/);
  });

  it("UN DOSSIER COMPAGNON se corrige dans son circuit d'origine", async () => {
    const id = await nouvelle("Compagnon");
    await prisma.paymentRequest.update({ where: { id }, data: { origin: "EXPENSE_ORDER" } });
    expect(err(await corriger("req", { id, amount: "1" }))).toMatch(/autre circuit/);
  });

  it("TÉMOIN : le centre autorise PENDANT la correction — la règle rejuge sur le fait réel, et la hausse rouvre", async () => {
    const { id, orderId } = await renvoyee("Course centre");
    const r = await pendantLaLecture("ExpenseOrder",
      () => corriger("req", { id, amount: "900000", note: "hausse pendant la décision" }),
      (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { centralStatus: "APPROVED", centralDecidedById: u.dir, centralDecidedAt: new Date() } }));
    expect(err(r)).toBeNull();
    const o = await ordre(orderId);
    expect(Number(o.amount)).toBe(900_000);
    expect(o.centralStatus, "une autorisation donnée sur 500 000 ne couvre pas 900 000").toBe("AWAITING");
  });

  it("TÉMOIN : un règlement passe PENDANT la correction — tout est annulé, la demande comprise", async () => {
    const { id, orderId } = await renvoyee("Course règlement", { autorisee: true });
    const r = await pendantLaLecture("ExpenseOrder",
      () => corriger("req", { id, amount: "300000", note: "baisse" }),
      (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { status: "PAID" } }));
    expect(err(r)).toMatch(/déjà réglé/);
    expect(Number((await ordre(orderId)).amount), "un ordre payé ne change pas de montant").toBe(500_000);
    expect(Number((await demande(id)).amount), "et la demande non plus : jamais la moitié d'une correction").toBe(500_000);
  });

  it("TÉMOIN : le dossier repart chez les Finances PENDANT la correction — rien n'est écrit", async () => {
    const { id, orderId } = await renvoyee("Course dossier");
    const r = await pendantLaLecture("PaymentRequest",
      () => corriger("req", { id, amount: "300000", note: "baisse" }),
      (tx) => tx.paymentRequest.update({ where: { id }, data: { status: "SUBMITTED" } }));
    expect(err(r)).toMatch(/vient de changer de main/);
    expect(Number((await demande(id)).amount)).toBe(500_000);
    expect(Number((await ordre(orderId)).amount)).toBe(500_000);
  });

  it("TÉMOIN : le montant de l'ordre bouge PENDANT une correction du seul bénéficiaire — celui qu'on avait lu ne l'écrase pas", async () => {
    const { id, orderId } = await renvoyee("Course montant");
    const r = await pendantLaLecture("ExpenseOrder",
      () => corriger("req", { id, payee: "EURL Ziryab", note: "raison sociale" }),
      (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { amount: 450_000 } }));
    expect(err(r)).toBeNull();
    const o = await ordre(orderId);
    expect(o.beneficiary).toBe("EURL Ziryab");
    expect(Number(o.amount), "le montant posé pendant la correction reste : on n'écrit pas celui d'avant").toBe(450_000);
  });

  it("TÉMOIN : le bénéficiaire de l'ordre bouge PENDANT une correction du seul montant — celui qu'on avait lu ne l'écrase pas", async () => {
    const { id, orderId } = await renvoyee("Course bénéficiaire");
    const r = await pendantLaLecture("ExpenseOrder",
      () => corriger("req", { id, amount: "450000", note: "facture définitive" }),
      (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { beneficiary: "EURL Ziryab" } }));
    expect(err(r)).toBeNull();
    const o = await ordre(orderId);
    expect(Number(o.amount)).toBe(450_000);
    expect(o.beneficiary, "le bénéficiaire posé pendant la correction reste").toBe("EURL Ziryab");
  });

  describe("le centre décide sur ce qu'il a LU", () => {
    it("un montant corrigé pendant la lecture se dit, avec les deux chiffres", async () => {
      const { id, orderId } = await renvoyee("Lu montant");
      expect(err(await corriger("req", { id, amount: "700000", note: "hausse" }))).toBeNull();
      await comme("dir");
      expect(err(await decidePayment(form({ id: orderId, decision: "APPROVE", montantVu: "500000", beneficiaireVu: "SARL Atlas" }))))
        .toBe(`Le montant de ce paiement a changé pendant que vous lisiez (${(500_000).toLocaleString("fr-FR")} → ${(700_000).toLocaleString("fr-FR")} DZD) : relisez l'ordre avant de décider.`);
      expect((await ordre(orderId)).centralStatus).toBe("AWAITING");
    });

    it("un bénéficiaire changé pendant la lecture aussi ; la casse ne compte pas", async () => {
      const { id, orderId } = await renvoyee("Lu bénéficiaire");
      expect(err(await corriger("req", { id, payee: "EURL Ziryab", note: "raison sociale" }))).toBeNull();
      await comme("dir");
      expect(err(await decidePayment(form({ id: orderId, decision: "APPROVE", montantVu: "500000", beneficiaireVu: "SARL Atlas" })))).toMatch(/Le bénéficiaire de ce paiement a changé/);
      expect(err(await decidePayment(form({ id: orderId, decision: "APPROVE", montantVu: "500000", beneficiaireVu: "eurl  ziryab" })))).toBeNull();
    });

    it("TÉMOIN : le montant bouge entre la lecture et l'écriture du centre — la décision n'est pas écrite", async () => {
      const { orderId } = await renvoyee("Écriture centre montant");
      await comme("dir");
      const r = await pendantLaLecture("ExpenseOrder",
        () => decidePayment(form({ id: orderId, decision: "APPROVE" })),
        (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { amount: 900_000 } }));
      expect(err(r)).toBe("Ce paiement vient de changer (décidé par un autre siège, corrigé ou annulé) : rouvrez le centre.");
      expect((await ordre(orderId)).centralStatus).toBe("AWAITING");
      expect(await prisma.paymentCentreMessage.count({ where: { orderId, decision: "APPROVE" } }), "pas de message pour une décision perdue").toBe(0);
    });

    it("TÉMOIN : deux sièges tranchent à la même seconde — le second n'écrase pas le premier", async () => {
      const { orderId } = await renvoyee("Deux sièges");
      await comme("dir");
      const r = await pendantLaLecture("ExpenseOrder",
        () => decidePayment(form({ id: orderId, decision: "APPROVE" })),
        (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { centralStatus: "REFUSED" } }));
      expect(err(r)).toMatch(/vient de changer/);
      expect((await ordre(orderId)).centralStatus, "un refus ne devient pas une autorisation sans que personne l'ait vue").toBe("REFUSED");
    });

    it("TÉMOIN : l'ordre est annulé entre la lecture et l'écriture du centre — on n'autorise pas un paiement annulé", async () => {
      const { orderId } = await renvoyee("Écriture centre annulé");
      await comme("dir");
      const r = await pendantLaLecture("ExpenseOrder",
        () => decidePayment(form({ id: orderId, decision: "APPROVE" })),
        (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { status: "CANCELLED" } }));
      expect(err(r)).toMatch(/vient de changer/);
      expect((await ordre(orderId)).centralStatus, "un paiement annulé ne reçoit pas d'autorisation").toBe("AWAITING");
    });

    it("TÉMOIN : le bénéficiaire bouge entre la lecture et l'écriture du centre — la décision n'est pas écrite", async () => {
      const { orderId } = await renvoyee("Écriture centre bénéficiaire");
      await comme("dir");
      const r = await pendantLaLecture("ExpenseOrder",
        () => decidePayment(form({ id: orderId, decision: "APPROVE" })),
        (tx) => tx.expenseOrder.update({ where: { id: orderId }, data: { beneficiary: "EURL Ziryab" } }));
      expect(err(r)).toMatch(/vient de changer/);
      expect((await ordre(orderId)).centralStatus).toBe("AWAITING");
    });
  });

  describe("les pièces : remplacer chez le demandeur, et le dossier qu'il garde", () => {
    const pieces = (requestId: string) => prisma.paymentPiece.findMany({ where: { requestId }, orderBy: { position: "asc" }, select: { id: true, status: true, replacesId: true } });
    const remplacer = async (k: string, requestId: string, replacesId: string) => {
      await comme(k);
      const fd = new FormData();
      fd.set("requestId", requestId); fd.set("replacesId", replacesId); fd.set("kind", "INVOICE");
      fd.set("file", new File(["y"], "nouvelle.pdf", { type: "application/pdf" }));
      return addPaymentPiece(fd);
    };

    it("au brouillon, le demandeur remplace une pièce que personne n'a examinée — elle n'est pas déclarée acceptée", async () => {
      await comme("req");
      const r = await createPaymentRequest(undefined, form({ title: `${TAG}Pièce brouillon`, payee: "A", amount: "1000", submit: "0", paymentMethodStated: "on" }, [{ kind: "INVOICE" }]));
      created.push(r.id!);
      const [p0] = await pieces(r.id!);
      expect(err(await remplacer("req", r.id!, p0!.id))).toBeNull();
      const apres = await pieces(r.id!);
      expect(apres.find((p) => p.id === p0!.id)?.status, "on ne déclare pas « acceptée » une pièce que personne n'a examinée").toBe("PENDING");
      expect(apres.some((p) => p.replacesId === p0!.id)).toBe(true);
      expect((await demande(r.id!)).status).toBe("DRAFT");
    });

    it("au brouillon, les Finances n'examinent pas les pièces — et le brouillon ne change pas de camp", async () => {
      await comme("req");
      const r = await createPaymentRequest(undefined, form({ title: `${TAG}Brouillon examiné`, payee: "A", amount: "1000", submit: "0", paymentMethodStated: "on" }, [{ kind: "INVOICE" }]));
      created.push(r.id!);
      const [p0] = await pieces(r.id!);
      await comme("fin");
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "CHANGES_REQUESTED", note: "illisible" })))).toMatch(/encore un brouillon/);
      expect((await demande(r.id!)).status).toBe("DRAFT");
    });

    it("chez les Finances, une pièce qu'elles n'ont pas mise en cause ne se remplace pas", async () => {
      const id = await nouvelle("Pièce chez les Finances", { transmise: true });
      const [p0] = await pieces(id);
      expect(err(await remplacer("req", id, p0!.id))).toMatch(/quand les Finances la signalent/);
    });

    it("remplacer la dernière pièce en cause GARDE le dossier chez le demandeur — il le renvoie quand il a fini", async () => {
      const id = await nouvelle("Garde", { transmise: true });
      const [p0] = await pieces(id);
      await comme("fin");
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "CHANGES_REQUESTED", note: "montant faux" })))).toBeNull();
      expect((await demande(id)).status).toBe("CHANGES_REQUESTED");
      const r = await remplacer("req", id, p0!.id);
      expect(err(r)).toBeNull();
      expect(r.message).toMatch(/renvoyez le dossier aux Finances/);
      expect((await demande(id)).status, "le dossier ne repart pas au milieu d'une correction").toBe("CHANGES_REQUESTED");
      // Il peut encore corriger le montant, puis renvoyer.
      expect(err(await corriger("req", { id, amount: "450000", note: "facture corrigée" }))).toBeNull();
      await comme("req");
      expect(err(await submitPaymentRequest(form({ id })))).toBeNull();
      expect((await demande(id)).status).toBe("SUBMITTED");
    });

    it("une pièce REMPLACÉE ne compte pas pour le bon à payer — la remplaçante doit être examinée", async () => {
      const id = await nouvelle("Bon à payer", { transmise: true });
      const [p0] = await pieces(id);
      await comme("fin");
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "CHANGES_REQUESTED", note: "illisible" })))).toBeNull();
      expect(err(await remplacer("req", id, p0!.id))).toBeNull();
      await comme("req");
      expect(err(await submitPaymentRequest(form({ id })))).toBeNull();
      await comme("fin");
      expect(err(await decidePaymentRequest(form({ id, move: "APPROVE" })))).toBe("Aucune pièce validée pour l'instant.");
      // La remplacée ne s'examine plus : un verdict posé sur elle réécrirait l'histoire sans rien décider.
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "ACCEPTED" })))).toBe("Cette pièce a été remplacée : c'est sa remplaçante qui s'examine.");
      const nouvellePiece = (await pieces(id)).find((p) => p.replacesId === p0!.id)!;
      expect(err(await reviewPaymentPiece(form({ pieceId: nouvellePiece.id, verdict: "ACCEPTED" })))).toBeNull();
      expect(err(await decidePaymentRequest(form({ id, move: "APPROVE" })))).toBeNull();
    });

    it("la vue globale qui SUPPLÉE le demandeur n'est pas lui : la pièce qu'elle remplace relance le décompte", async () => {
      const id = await nouvelle("Suppléance", { transmise: true });
      const [p0] = await pieces(id);
      await comme("fin");
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "CHANGES_REQUESTED", note: "illisible" })))).toBeNull();
      expect(err(await remplacer("dir", id, p0!.id))).toBeNull();
      expect((await demande(id)).status, "seul un geste DU demandeur lui garde le dossier").toBe("SUBMITTED");
    });

    it("un geste des FINANCES peut ramener le dossier chez elles : lever la dernière réserve le renvoie", async () => {
      const id = await nouvelle("Réserve levée", { transmise: true });
      const [p0] = await pieces(id);
      await comme("fin");
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "CHANGES_REQUESTED", note: "à vérifier" })))).toBeNull();
      expect((await demande(id)).status).toBe("CHANGES_REQUESTED");
      expect(err(await reviewPaymentPiece(form({ pieceId: p0!.id, verdict: "ACCEPTED", note: "vérifié par téléphone" })))).toBeNull();
      expect((await demande(id)).status).toBe("SUBMITTED");
    });
  });
});
