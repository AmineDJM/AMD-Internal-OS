import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import {
  createRequest, editOwnRequest, deleteOwnRequest, addRequestComment, startRequestProcessing, assignRequest,
  requestInternalValidation, requestFinanceValidation, requestApproval, decideApproval, finishRequest, deleteRequests,
  submitAttachmentValidation,
} from "@/lib/actions/admin-request-actions";
import type { Prisma } from "@prisma/client";
import { decideValidation } from "@/lib/actions/validation-actions";
import { createExpenseOrder } from "@/modules/finances/api";
import { TITRE_BC_A_ETABLIR } from "@/lib/ad-pro/pieces-secretariat";
import { retirerValidationSansObjet } from "@/lib/validation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__secrdem__";
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
const DEUX_HEURES = 2 * 60 * 60 * 1000;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DEMANDEUR ET SA DEMANDE AU SECRÉTARIAT — par les VRAIS points d'entrée (§118.187, audit R08/R09).
 *
 * « Passé trente minutes, la demande est figée : on ne peut ni modifier ses références, ni l'annuler,
 * et le commentaire, seul canal restant, ne prévient personne quand elle n'a pas de responsable. »
 * Chaque geste passe par l'action de l'écran ; le temps qui passe est le seul fait posé à la main
 * (la date de création, reculée de deux heures), parce que c'est la seule chose qu'un banc ne peut pas
 * attendre. Chaque acteur est NOMMÉ dans son cas (§118.151f), et aucun n'a la vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Secrétariat — le demandeur corrige, annule, et sa parole arrive à quelqu'un", () => {
  let demId = "", autreId = "", a1Id = "", a2Id = "", valId = "";
  const demandes: string[] = [];
  const ordres: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    // DEUX ASSISTANTES : sans responsable, le bureau ENTIER doit l'apprendre — avec une seule, le banc
    // ne distinguerait pas « le rôle » de « la première trouvée » (§118.34).
    const [dem, autre, a1, a2, val] = await Promise.all([
      mk("dem", "MEDICAL_DELEGATE"), mk("autre", "MEDICAL_DELEGATE"),
      mk("a1", "DIRECTION_ASSISTANT"), mk("a2", "DIRECTION_ASSISTANT"), mk("val", "GENERAL_MANAGER"),
    ]);
    demId = dem.id; autreId = autre.id; a1Id = a1.id; a2Id = a2.id; valId = val.id;
  });

  afterAll(async () => {
    const comptes = [demId, autreId, a1Id, a2Id, valId].filter(Boolean);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { requestId: { in: demandes } } }).catch(() => {});
    const tous = await prisma.expenseOrder.findMany({ where: { OR: [{ id: { in: ordres } }, { sourceType: "ADMIN_REQUEST", sourceId: { in: demandes } }] }, select: { id: true } }).catch(() => []);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: tous.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: tous.map((o) => o.id) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: demandes } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  /** Une demande déposée par l'écran — et, si l'on veut, vieillie de deux heures. */
  async function deposer(titre: string, opts: { vieillie?: boolean; type?: string; champs?: Record<string, string>; par?: "dem" | "a1" } = {}): Promise<string> {
    ACTOR = opts.par === "a1" ? await acteur(a1Id, "DIRECTION_ASSISTANT") : await acteur(demId, "MEDICAL_DELEGATE");
    const r = await createRequest(undefined, fd({ type: opts.type ?? "OTHER", title: `${TAG}${titre}`, description: "Texte d'origine", priority: "HIGH", deadline: "2026-11-10", ...(opts.champs ?? {}) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const id = r.id!;
    demandes.push(id);
    if (opts.vieillie) await prisma.administrativeRequest.update({ where: { id }, data: { createdAt: new Date(Date.now() - DEUX_HEURES) } });
    return id;
  }
  /** Attendre que `n` sessions soient bloquées sur la table (le snapshot se rafraîchit à chaque tour). */
  async function attendreBloques(tx: Prisma.TransactionClient, table: string, n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ANY(${[`%${table}%`]}::text[])`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`${k} geste(s) bloqué(s) sur ${table}, ${n} attendu(s)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /**
   * UN GESTE ARRÊTÉ ENTRE SA LECTURE ET SON ÉCRITURE pendant qu'un autre écrit (§118.164e) : le détenteur
   * du verrou SHARE écrit lui-même le changement concurrent, puis relâche — déterministe.
   */
  async function pendantLaLecture<T>(table: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      await attendreBloques(tx, table, 1);
      await concurrent(tx);
    }, { timeout: 20_000 });
    return geste;
  }
  /** Deux gestes forcés à se croiser : ils lisent tous deux avant que l'un écrive. */
  async function ensemble<T>(table: string, lancer: () => Promise<T>[]): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, table, gestes.length);
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  const avisPour = (userIds: string[], id: string, titre: string, depuis: Date) =>
    prisma.notification.findMany({ where: { userId: { in: userIds }, link: `/demandes/${id}`, title: titre, createdAt: { gte: depuis } }, select: { userId: true } });

  it("PRÉMISSES : le demandeur et l'autre délégué n'ont ni la vue globale ni la gestion du bureau ; les assistantes l'ont", async () => {
    const dem = await acteur(demId, "MEDICAL_DELEGATE");
    expect(hasGlobalView(dem) || userCan(dem, "ADMIN_REQUESTS", "UPDATE"), "sinon il corrigerait par le droit du bureau, pas par la porte du demandeur").toBe(false);
    expect(userCan(dem, "ADMIN_REQUESTS", "CREATE")).toBe(true);
    expect(userCan(await acteur(a1Id, "DIRECTION_ASSISTANT"), "ADMIN_REQUESTS", "UPDATE")).toBe(true);
  });

  it("DANS LA FENÊTRE : corrigée sans déranger personne — ni commentaire, ni notification", async () => {
    const id = await deposer("Fenêtre discrète");
    const t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await editOwnRequest(fd({ id, title: `${TAG}Fenêtre discrète — corrigée`, description: "Texte d'origine", priority: "HIGH", deadline: "2026-11-12" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toBe("Demande modifiée.");
    expect(await prisma.comment.count({ where: { entityType: "ADMIN_REQUEST", entityId: id } })).toBe(0);
    expect(await avisPour([a1Id, a2Id], id, "Demande corrigée par son demandeur", t0)).toHaveLength(0);
  });

  it("AU-DELÀ DE TRENTE MINUTES : corrigée encore — le bureau entier prévenu (sans responsable), la discussion garde ce qui a changé", async () => {
    const id = await deposer("Au-delà", { vieillie: true });
    const t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await editOwnRequest(fd({ id, title: `${TAG}Au-delà`, description: "Texte d'origine", priority: "HIGH", deadline: "2026-11-20" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/l'assistante est prévenue \(l'échéance\)/);
    const avis = await avisPour([a1Id, a2Id], id, "Demande corrigée par son demandeur", t0);
    expect(avis.map((a) => a.userId).sort(), "les DEUX assistantes — une demande sans responsable revient au bureau").toEqual([a1Id, a2Id].sort());
    const c = await prisma.comment.findFirstOrThrow({ where: { entityType: "ADMIN_REQUEST", entityId: id }, select: { body: true, authorId: true } });
    expect(c.body).toBe("Demande corrigée par son demandeur : l'échéance.");
    expect(c.authorId).toBe(demId);
  });

  it("CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS — les lignes d'achat, la description et la priorité survivent", async () => {
    const id = await deposer("Achat à lignes", { vieillie: true, type: "PURCHASE", champs: { f_article: "Ramettes" } });
    // Décor : les LIGNES d'une demande d'achat vivent dans le même JSON, hors des champs du formulaire.
    await prisma.administrativeRequest.update({
      where: { id },
      data: { fields: { article: "Ramettes", purchaseLines: [{ label: "Ramette A4", quantity: 10, unitPrice: 650 }], estimatedTotal: 6500 } },
    });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await editOwnRequest(fd({ id, deadline: "2026-12-01", f_quantite: "12" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { fields: true, description: true, priority: true, title: true } });
    const champs = apres.fields as Record<string, unknown>;
    expect(champs.purchaseLines, "l'ancien remplacement intégral effaçait les lignes").toEqual([{ label: "Ramette A4", quantity: 10, unitPrice: 650 }]);
    expect(champs.estimatedTotal).toBe(6500);
    expect(champs.article).toBe("Ramettes");
    expect(champs.quantite).toBe("12");
    expect(apres.description, "une clé absente garde sa valeur").toBe("Texte d'origine");
    expect(apres.priority, "et la priorité ne retombe pas à « moyenne »").toBe("HIGH");
    expect(apres.title).toBe(`${TAG}Achat à lignes`);
    // Une clé PORTÉE vide efface — c'est ce qui distingue « je vide » de « je ne touche pas ».
    const vide = await editOwnRequest(fd({ id, f_quantite: "" }));
    expect(vide.ok).toBe(true);
    expect(((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { fields: true } })).fields as Record<string, unknown>).quantite).toBeUndefined();
  });

  it("ASSIGNÉE : seule la responsable est prévenue — l'autre assistante n'est pas dérangée", async () => {
    const id = await deposer("Assignée", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await assignRequest(fd({ id, assignedToId: a1Id }))).ok).toBe(true);
    const t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    expect((await editOwnRequest(fd({ id, title: `${TAG}Assignée — v2` }))).ok).toBe(true);
    const avis = await avisPour([a1Id, a2Id], id, "Demande corrigée par son demandeur", t0);
    expect(avis.map((a) => a.userId)).toEqual([a1Id]);
  });

  it("PENDANT UNE VALIDATION : la correction est refusée, avec son remède — et rien n'est écrit", async () => {
    const id = await deposer("Sous validation", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const v = await requestInternalValidation(fd({ id, validatorId: valId, comment: "Avis demandé" }));
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await editOwnRequest(fd({ id, title: `${TAG}Sous validation — changée` }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/validation est en cours/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { title: true } })).title).toBe(`${TAG}Sous validation`);
  });

  it("UNE APPROBATION EN ATTENTE ferme la correction comme une validation ; une validation de PIÈCE ne la ferme pas", async () => {
    const id = await deposer("Sous approbation", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "20000" }))).ok).toBe(true);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await editOwnRequest(fd({ id, title: `${TAG}Sous approbation — changée` }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/validation est en cours/);

    // Une validation de PIÈCE est un avis sur la pièce, pas sur la demande : elle ne fige pas son texte.
    const piece = await deposer("Pièce sous avis", { vieillie: true });
    await prisma.validationRequest.create({
      data: { reference: `${RUN.slice(-10)}-VD`, module: "Bureau du secrétariat", title: "Avis sur la facture", requesterId: a1Id, entityType: "ADMIN_REQUEST", entityId: piece, documentId: `${RUN}doc`, status: "PENDING" },
    });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const p = await editOwnRequest(fd({ id: piece, title: `${TAG}Pièce sous avis — corrigée` }));
    expect(p.ok, p.ok ? "" : p.error).toBe(true);
  });

  it("L'AUTRICE ASSISTANTE n'est pas prévenue de son propre geste — l'autre assistante, oui", async () => {
    const id = await deposer("Demande d'une assistante", { vieillie: true, par: "a1" });
    const t0 = new Date();
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await editOwnRequest(fd({ id, title: `${TAG}Demande d'une assistante — v2` }))).ok).toBe(true);
    expect((await avisPour([a1Id, a2Id], id, "Demande corrigée par son demandeur", t0)).map((a) => a.userId)).toEqual([a2Id]);
  });

  it("UN PAIEMENT ÉMIS : la correction refusée — l'annulation l'emporte, et le paiement non réglé part avec elle", async () => {
    const id = await deposer("Paiement émis", { vieillie: true });
    const ordre = await createExpenseOrder({ label: `${TAG}Ordre`, amount: 15_000, category: "AUTRE", sourceType: "ADMIN_REQUEST", sourceId: id, requestedById: a1Id });
    ordres.push(ordre.id);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const corr = await editOwnRequest(fd({ id, title: `${TAG}Paiement émis — changé` }));
    expect(corr.ok).toBe(false);
    expect(corr.error).toMatch(/paiement est déjà émis/);

    const sansMotif = await deleteOwnRequest(fd({ id }));
    expect(sansMotif.ok, "au-delà de la fenêtre, une annulation porte son motif").toBe(false);
    expect(sansMotif.error).toMatch(/Dites pourquoi/);

    const t0 = new Date();
    const r = await deleteOwnRequest(fd({ id, motif: "Le congrès est reporté." }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(new RegExp(`paiement ${ordre.reference} annulé`));
    const d = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true, deletedAt: true, cancelledAt: true } });
    expect(d.status).toBe("CANCELLED");
    expect(d.deletedAt, "close, pas effacée : quelqu'un a peut-être déjà travaillé dessus").toBeNull();
    expect(d.cancelledAt).not.toBeNull();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id }, select: { status: true } })).status, "le paiement ne survit pas à sa demande").toBe("CANCELLED");
    const c = await prisma.comment.findFirstOrThrow({ where: { entityType: "ADMIN_REQUEST", entityId: id }, select: { body: true } });
    expect(c.body).toBe("Demande annulée par son demandeur : Le congrès est reporté.");
    expect((await avisPour([a1Id, a2Id], id, "Demande au secrétariat annulée", t0)).length).toBe(2);
  });

  it("UN PAIEMENT RÉGLÉ : l'annulation est refusée AVANT de toucher quoi que ce soit", async () => {
    const id = await deposer("Paiement réglé", { vieillie: true });
    const ordre = await createExpenseOrder({ label: `${TAG}Ordre réglé`, amount: 9_000, category: "AUTRE", sourceType: "ADMIN_REQUEST", sourceId: id, requestedById: a1Id });
    ordres.push(ordre.id);
    await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { status: "PAID" } });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestInternalValidation(fd({ id, validatorId: valId }))).ok).toBe(true);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await deleteOwnRequest(fd({ id, motif: "Plus besoin." }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`${ordre.reference} de la demande .* est déjà réglé`));
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("AWAITING_VALIDATION");
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: id, status: "PENDING" } }), "la validation n'a pas été retirée").toBe(1);
  });

  it("L'ANNULATION EMPORTE LES VALIDATIONS ET APPROBATIONS EN ATTENTE — leur validateur le sait", async () => {
    const id = await deposer("Validations en attente", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestInternalValidation(fd({ id, validatorId: valId }))).ok).toBe(true);
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "40000" }))).ok).toBe(true);
    const t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await deleteOwnRequest(fd({ id, motif: "Doublon de REQ précédente." }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/2 validations retirées/);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: id, status: "PENDING" } })).toBe(0);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: id, status: "CANCELLED" } })).toBe(1);
    expect(await prisma.adminApproval.count({ where: { requestId: id, status: "PENDING" } }), "une approbation restée en file paierait une demande retirée").toBe(0);
    expect((await avisPour([valId], id, "Validation retirée", t0)).length).toBe(2);
  });

  it("DANS LA FENÊTRE, la suppression reste douce et silencieuse ; un motif n'y est pas exigé", async () => {
    const id = await deposer("Supprimée vite");
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await deleteOwnRequest(fd({ id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const d = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true, deletedAt: true } });
    expect(d.status).toBe("CANCELLED");
    expect(d.deletedAt).not.toBeNull();
  });

  it("TERMINÉE : refusée avec son remède ; un autre que le demandeur : refusé", async () => {
    const id = await deposer("Terminée", { vieillie: true });
    ACTOR = await acteur(autreId, "MEDICAL_DELEGATE");
    const intrus = await editOwnRequest(fd({ id, title: `${TAG}Intrus` }));
    expect(intrus.ok).toBe(false);
    expect(intrus.error).toMatch(/Seule la personne qui a fait la demande/);
    expect((await deleteOwnRequest(fd({ id, motif: "x" }))).ok).toBe(false);
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await finishRequest(fd({ id }))).ok).toBe(true);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await editOwnRequest(fd({ id, title: `${TAG}Trop tard` }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/terminée.*nouvelle demande en citant sa référence/);
  });

  it("LE COMMENTAIRE DU DEMANDEUR arrive au bureau entier sans responsable — à la seule responsable sinon", async () => {
    const id = await deposer("Commentaire", { vieillie: true });
    let t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    expect((await addRequestComment(fd({ requestId: id, body: "La référence fournisseur est FR-2207." }))).ok).toBe(true);
    expect((await avisPour([a1Id, a2Id], id, "Nouveau commentaire", t0)).map((a) => a.userId).sort(), "avant : personne n'était prévenu").toEqual([a1Id, a2Id].sort());
    ACTOR = await acteur(a2Id, "DIRECTION_ASSISTANT");
    expect((await assignRequest(fd({ id, assignedToId: a2Id }))).ok).toBe(true);
    t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    expect((await addRequestComment(fd({ requestId: id, body: "Et la quantité passe à 12." }))).ok).toBe(true);
    expect((await avisPour([a1Id, a2Id], id, "Nouveau commentaire", t0)).map((a) => a.userId)).toEqual([a2Id]);
    // L'assistante qui répond parle au demandeur.
    t0 = new Date();
    ACTOR = await acteur(a2Id, "DIRECTION_ASSISTANT");
    expect((await addRequestComment(fd({ requestId: id, body: "Bien noté." }))).ok).toBe(true);
    expect((await avisPour([demId, a1Id], id, "Nouveau commentaire", t0)).map((a) => a.userId)).toEqual([demId]);
  });

  it("COMMENCER LE TRAITEMENT désigne la personne qui commence — et une demande annulée ne se commence pas", async () => {
    const id = await deposer("À commencer");
    ACTOR = await acteur(a2Id, "DIRECTION_ASSISTANT");
    expect((await startRequestProcessing(fd({ id }))).ok).toBe(true);
    const d = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true, assignedToId: true } });
    expect(d.status).toBe("IN_PROGRESS");
    expect(d.assignedToId, "sans responsable, le commentaire suivant serait reparti vers tout le bureau").toBe(a2Id);

    const annulee = await deposer("Annulée puis commencée", { vieillie: true });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    expect((await deleteOwnRequest(fd({ id: annulee, motif: "Inutile." }))).ok).toBe(true);
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const r = await startRequestProcessing(fd({ id: annulee }));
    expect(r.ok, "commencer ressusciterait la demande annulée").toBe(false);
    expect(r.error).toMatch(/a été annulée/);
    const terminer = await finishRequest(fd({ id: annulee }));
    expect(terminer.ok, "ni la terminer").toBe(false);
    expect(terminer.error).toMatch(/a été annulée/);
    // Ni lui demander une validation — interne, Finances, ou un montant à approuver : chacune la
    // ressusciterait « en attente de validation », et la dernière ferait partir un paiement.
    const interne = await requestInternalValidation(fd({ id: annulee, validatorId: valId }));
    expect(interne.ok).toBe(false);
    expect(interne.error).toMatch(/a été annulée/);
    const finances = await requestFinanceValidation(fd({ id: annulee, validatorId: valId }));
    expect(finances.ok).toBe(false);
    expect(finances.error).toMatch(/a été annulée/);
    const montant = await requestApproval(fd({ requestId: annulee, validatorId: valId, amount: "10000" }));
    expect(montant.ok).toBe(false);
    expect(montant.error).toMatch(/a été annulée/);
    expect(await prisma.adminApproval.count({ where: { requestId: annulee } })).toBe(0);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: annulee, status: "PENDING" } })).toBe(0);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: annulee }, select: { status: true } })).status).toBe("CANCELLED");
  });

  it("UNE APPROBATION SUR UNE DEMANDE EFFACÉE NE PAIE PLUS", async () => {
    const id = await deposer("Effacée sous approbation");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "50000" }))).ok).toBe(true);
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id }, select: { id: true } });
    expect((await deleteRequests(fd({ ids: id, reason: "Doublon." }))).ok).toBe(true);
    // SUPPRIMER, C'EST ANNULER CE QUI EN DÉPEND (audit du 14/10/2026) : l'approbation en attente part avec la demande.
    expect(await prisma.adminApproval.count({ where: { requestId: id, status: "PENDING" } }), "avant : elle restait en file chez le validateur").toBe(0);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("CANCELLED");
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    const r = await decideApproval(fd({ approvalId: appro.id, decision: "APPROVED" }));
    expect(r.ok).toBe(false);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id } }), "aucun ordre de dépense pour une demande retirée").toBe(0);
  });

  it("UNE VALIDATION TRANCHÉE APRÈS LA FIN NE RESSUSCITE PAS LA DEMANDE", async () => {
    const id = await deposer("Validée après la fin");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestInternalValidation(fd({ id, validatorId: valId }))).ok).toBe(true);
    expect((await finishRequest(fd({ id }))).ok).toBe(true);
    const step = await prisma.validationStep.findFirstOrThrow({ where: { request: { entityType: "ADMIN_REQUEST", entityId: id } }, select: { id: true } });
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    expect((await decideValidation(fd({ stepId: step.id, decision: "APPROVED" }))).ok).toBe(true);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("DONE");
  });

  it("UNE APPROBATION TRANCHÉE APRÈS LA FIN NE RESSUSCITE PAS LA DEMANDE — le paiement autorisé, lui, part", async () => {
    const id = await deposer("Approuvée après la fin");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "30000" }))).ok).toBe(true);
    // « Fin » est refusée tant que la validation attend (audit du 14/10/2026) ; une demande terminée AVANT cette règle
    // (ou par un chemin qu'elle ne couvre pas) se simule en base — c'est la garde de la décision qu'on éprouve ici.
    const fin = await finishRequest(fd({ id }));
    expect(fin.ok).toBe(false);
    expect(fin.error).toBe("Une validation est en attente sur cette demande : attendez la réponse avant de terminer.");
    await prisma.administrativeRequest.update({ where: { id }, data: { status: "DONE", completedAt: new Date() } });
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id }, select: { id: true } });
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    expect((await decideApproval(fd({ approvalId: appro.id, decision: "APPROVED" }))).ok).toBe(true);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status, "avant : « en attente de paiement » sur une demande terminée").toBe("DONE");
    expect(await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id } }), "le montant a bien été autorisé").toBe(1);
  });

  it("DEUX APPROBATIONS SIMULTANÉES DU MÊME MONTANT : une seule passe, un seul ordre de dépense", async () => {
    const id = await deposer("Double approbation");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "45000" }))).ok).toBe(true);
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id }, select: { id: true } });
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    const [a, b] = await ensemble("AdminApproval", () => [
      decideApproval(fd({ approvalId: appro.id, decision: "APPROVED" })),
      decideApproval(fd({ approvalId: appro.id, decision: "APPROVED" })),
    ]);
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id } }), "avant : deux ordres pour une approbation").toBe(1);
  });

  it("ÉCRITURES CONDITIONNELLES : ce qui change entre la lecture et l'écriture l'emporte", async () => {
    // 1. L'assistante COMMENCE pendant que le demandeur supprime dans la fenêtre : la suppression douce ne passe pas.
    const vite = await deposer("Course suppression");
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const s1 = await pendantLaLecture("AdministrativeRequest",
      () => deleteOwnRequest(fd({ id: vite })),
      (tx) => tx.administrativeRequest.update({ where: { id: vite }, data: { status: "IN_PROGRESS", processingStartedAt: new Date() } }),
    );
    expect(s1.ok, JSON.stringify(s1)).toBe(false);
    expect(s1.error).toMatch(/L'assistante vient de commencer/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: vite }, select: { deletedAt: true } })).deletedAt).toBeNull();

    // 2. L'assistante TERMINE pendant que le demandeur annule : l'annulation ne réécrit pas une demande terminée.
    const fin = await deposer("Course annulation", { vieillie: true });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const s2 = await pendantLaLecture("AdministrativeRequest",
      () => deleteOwnRequest(fd({ id: fin, motif: "Plus utile." })),
      (tx) => tx.administrativeRequest.update({ where: { id: fin }, data: { status: "DONE", completedAt: new Date() } }),
    );
    expect(s2.ok, JSON.stringify(s2)).toBe(false);
    expect(s2.error).toMatch(/vient d'être terminée ou annulée/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: fin }, select: { status: true } })).status).toBe("DONE");
    expect(await prisma.comment.count({ where: { entityType: "ADMIN_REQUEST", entityId: fin } }), "aucune trace d'une annulation qui n'a pas eu lieu").toBe(0);

    // 3. Le demandeur ANNULE pendant que l'assistante commence : le traitement ne ressuscite pas la demande.
    const deb = await deposer("Course début", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const s3 = await pendantLaLecture("AdministrativeRequest",
      () => startRequestProcessing(fd({ id: deb })),
      (tx) => tx.administrativeRequest.update({ where: { id: deb }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(s3.ok, JSON.stringify(s3)).toBe(false);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: deb }, select: { status: true, assignedToId: true } }))).toEqual({ status: "CANCELLED", assignedToId: null });

    // 4. Le demandeur ANNULE pendant que l'assistante termine : la fin ne réécrit pas une demande annulée.
    const term = await deposer("Course fin", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const s4 = await pendantLaLecture("AdministrativeRequest",
      () => finishRequest(fd({ id: term })),
      (tx) => tx.administrativeRequest.update({ where: { id: term }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(s4.ok, JSON.stringify(s4)).toBe(false);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: term }, select: { status: true } })).status).toBe("CANCELLED");

    // 5. Le demandeur ANNULE pendant que l'assistante demande une validation : la validation née entre-temps
    //    est retirée aussitôt — l'annulation, passée avant elle, ne pouvait pas la voir.
    const val = await deposer("Course validation", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const s5 = await pendantLaLecture("AdministrativeRequest",
      () => requestInternalValidation(fd({ id: val, validatorId: valId })),
      (tx) => tx.administrativeRequest.update({ where: { id: val }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(s5.ok, JSON.stringify(s5)).toBe(false);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: val, status: "PENDING" } }), "aucune validation ne reste en file pour une demande annulée").toBe(0);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: val, status: "CANCELLED" } })).toBe(1);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: val }, select: { status: true } })).status).toBe("CANCELLED");

    // 5 bis. La MÊME course pour la validation des FINANCES (flux achat) : même compensation, autre
    //    action — sans ce cas, retirer sa compensation ne ferait tomber aucun test.
    const valF = await deposer("Course validation Finances", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const s5b = await pendantLaLecture("AdministrativeRequest",
      () => requestFinanceValidation(fd({ id: valF, validatorId: valId })),
      (tx) => tx.administrativeRequest.update({ where: { id: valF }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(s5b.ok, JSON.stringify(s5b)).toBe(false);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: valF, status: "PENDING" } }), "aucune validation des Finances ne reste en file pour une demande annulée").toBe(0);
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: valF, status: "CANCELLED" } })).toBe(1);

    // 6. De même pour un MONTANT à approuver : l'approbation née entre-temps paierait une demande annulée.
    const appro = await deposer("Course approbation", { vieillie: true });
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const s6 = await pendantLaLecture("AdministrativeRequest",
      () => requestApproval(fd({ requestId: appro, validatorId: valId, amount: "12000" })),
      (tx) => tx.administrativeRequest.update({ where: { id: appro }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(s6.ok, JSON.stringify(s6)).toBe(false);
    expect(await prisma.adminApproval.count({ where: { requestId: appro } }), "aucune approbation ne reste pour une demande annulée").toBe(0);

    // 7. Le demandeur CORRIGE pendant que la demande est annulée (par le poste qui l'avait ouverte, par
    //    exemple) : une demande annulée ne se réécrit plus.
    const corr = await deposer("Course correction", { vieillie: true });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const s7 = await pendantLaLecture("AdministrativeRequest",
      () => editOwnRequest(fd({ id: corr, title: `${TAG}Course correction — réécrite` })),
      (tx) => tx.administrativeRequest.update({ where: { id: corr }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(s7.ok, JSON.stringify(s7)).toBe(false);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: corr }, select: { title: true } })).title).toBe(`${TAG}Course correction`);
  });

  it("RETIRER UNE VALIDATION SANS OBJET : la demande nommée, seulement en attente — un identifiant absent ne retire RIEN", async () => {
    const mk = (suffixe: string, status: "PENDING" | "APPROVED") => prisma.validationRequest.create({
      data: { reference: `${RUN.slice(-8)}-${suffixe}`, module: "Bureau du secrétariat", title: `${TAG}retrait ${suffixe}`, requesterId: demId, status },
      select: { id: true },
    });
    const [cible, voisine, tranchee] = [await mk("R1", "PENDING"), await mk("R2", "PENDING"), await mk("R3", "APPROVED")];
    try {
      expect(await retirerValidationSansObjet(cible.id)).toBe(1);
      expect(await retirerValidationSansObjet(tranchee.id), "une décision déjà prise reste : c'est de l'histoire").toBe(0);
      // Pour Prisma, `id: undefined` ne filtre RIEN (mesuré : 3 lignes sur 3) — sans la garde, cet
      // appel retirerait TOUTES les validations en attente de la base, la voisine comprise.
      expect(await retirerValidationSansObjet(undefined as unknown as string)).toBe(0);
      const etats = await prisma.validationRequest.findMany({ where: { id: { in: [cible.id, voisine.id, tranchee.id] } }, select: { id: true, status: true } });
      const de = (id: string) => etats.find((e) => e.id === id)?.status;
      expect([de(cible.id), de(voisine.id), de(tranchee.id)]).toEqual(["CANCELLED", "PENDING", "APPROVED"]);
    } finally {
      await prisma.validationRequest.deleteMany({ where: { id: { in: [cible.id, voisine.id, tranchee.id] } } });
    }
  });

  it("LE « BC À ÉTABLIR » D'UN POSTE ne se corrige ni ne s'annule d'ici — le refus nomme le geste du poste", async () => {
    const r = await prisma.administrativeRequest.create({
      data: {
        reference: `${RUN.slice(-8)}-BC`, type: "OTHER", title: `${TAG}${TITRE_BC_A_ETABLIR} — Traiteur`, priority: "HIGH",
        requesterId: demId, status: "NEW", linkedEntityType: "AD_PRO_ITEM", linkedEntityId: `${RUN}poste`,
        createdAt: new Date(Date.now() - DEUX_HEURES),
      },
      select: { id: true },
    });
    demandes.push(r.id);
    // Le titre porte le TAG devant : la forme « BC à établir » se lit en TÊTE du titre — on la rend exacte.
    await prisma.administrativeRequest.update({ where: { id: r.id }, data: { title: `${TITRE_BC_A_ETABLIR} — ${TAG}Traiteur` } });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const e = await editOwnRequest(fd({ id: r.id, title: "autre chose" }));
    expect(e.ok).toBe(false);
    expect(e.error).toMatch(/« Modifier la demande de BC »/);
    const d = await deleteOwnRequest(fd({ id: r.id, motif: "x" }));
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/« Annuler la demande de BC »/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } })).status).toBe("NEW");
  });

  // ── AUDIT DU 14/10/2026 — « corrige tout de suite » ─────────────────────────────────────────────

  it("AUDIT — UNE PIÈCE CHIFFRÉE ne se fait pas valider par son demandeur, ni par l'assistante qui traite ; sans montant, l'avis reste libre", async () => {
    const id = await deposer("Pièce chiffrée");
    await prisma.administrativeRequest.update({ where: { id }, data: { assignedToId: a1Id } });
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    for (const validateur of [demId, a1Id]) {
      const f = fd({ requestId: id, documentId: "x", amount: "450000" });
      f.append("validatorIds", validateur);
      const r = await submitAttachmentValidation(f);
      expect(r.ok, "avant : le demandeur se choisissait validateur et faisait partir un paiement à son nom").toBe(false);
      expect(r.error).toMatch(/Une pièce chiffrée émet un paiement/);
    }
    expect(await prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: id } })).toBe(0);
  });

  it("AUDIT — UN ACHAT REFUSÉ ne se termine pas (il s'annule) ; une validation en attente non plus", async () => {
    const id = await deposer("Achat refusé");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await startRequestProcessing(fd({ id }))).ok).toBe(true);
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "20000" }))).ok).toBe(true);
    const enAttente = await finishRequest(fd({ id }));
    expect(enAttente.ok).toBe(false);
    expect(enAttente.error).toMatch(/validation est en attente/);
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id }, select: { id: true } });
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    expect((await decideApproval(fd({ approvalId: appro.id, decision: "REJECTED", comment: "Hors budget." }))).ok).toBe(true);
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const fin = await finishRequest(fd({ id }));
    expect(fin.ok, "avant : un achat refusé se terminait, et s'imputait au budget").toBe(false);
    expect(fin.error).toMatch(/refusée par son validateur/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("BLOCKED");
  });

  it("AUDIT — MODIFICATION DEMANDÉE : la correction du demandeur repart chez le même validateur, et rien ne se termine avant", async () => {
    const id = await deposer("Achat à corriger");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "15000" }))).ok).toBe(true);
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id }, select: { id: true } });
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    expect((await decideApproval(fd({ approvalId: appro.id, decision: "CHANGES_REQUESTED", comment: "Préciser le fournisseur." }))).ok).toBe(true);
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    const fin = await finishRequest(fd({ id }));
    expect(fin.ok, "avant : l'assistante achetait sans nouvelle validation").toBe(false);
    expect(fin.error).toMatch(/demandé une modification/);
    const t0 = new Date();
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const ed = await editOwnRequest(fd({ id, description: "Fournisseur : Bureau Plus, devis n° 42" }));
    expect(ed.ok, ed.ok ? "" : ed.error).toBe(true);
    expect(ed.message).toMatch(/repart chez/);
    const nouvelles = await prisma.adminApproval.findMany({ where: { requestId: id, status: "PENDING" }, select: { validatorId: true, amount: true } });
    expect(nouvelles).toHaveLength(1);
    expect(nouvelles[0]!.validatorId).toBe(valId);
    expect(Number(nouvelles[0]!.amount)).toBe(15000);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("AWAITING_VALIDATION");
    expect(await prisma.notification.count({ where: { userId: valId, title: "Demande corrigée — à revalider", createdAt: { gte: t0 } } })).toBe(1);
  });

  it("AUDIT — SUPPRIMER une demande ANNULE son paiement non réglé (il restait payable au centre)", async () => {
    const id = await deposer("Supprimée avec ordre");
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await requestApproval(fd({ requestId: id, validatorId: valId, amount: "8000" }))).ok).toBe(true);
    const appro = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id }, select: { id: true } });
    ACTOR = await acteur(valId, "GENERAL_MANAGER");
    expect((await decideApproval(fd({ approvalId: appro.id, decision: "APPROVED" }))).ok).toBe(true);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id, status: { not: "CANCELLED" } } }), "prémisse : un ordre est en vol").toBe(1);
    ACTOR = await acteur(a1Id, "DIRECTION_ASSISTANT");
    expect((await deleteRequests(fd({ ids: id, reason: "Doublon." }))).ok).toBe(true);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id, status: { not: "CANCELLED" } } }), "l'ordre part avec la demande").toBe(0);
  });
});
