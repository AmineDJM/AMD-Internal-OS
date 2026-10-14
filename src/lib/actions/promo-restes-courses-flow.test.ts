import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";
import type { ActionResult } from "@/lib/actions/types";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

/**
 * LES ENTRÉES DANS LES FILES (`enSerie`) — observées, pas espérées. Une course « file contre file » ne se
 * voit pas en base : le second geste attend dans le PROCESSUS, pas sur un verrou. Le banc sait qu'il y est
 * entré parce que la file le note ici, au moment même où il s'y présente — c'est ce qui rend les courses
 * ci-dessous déterministes (§118.65) sans jamais attendre « un peu ».
 */
const { appelsFile } = vi.hoisted(() => ({ appelsFile: [] as string[] }));
vi.mock("@/lib/refs", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/refs")>();
  return { ...m, enSerie: <T>(serie: string, fn: () => Promise<T>): Promise<T> => { appelsFile.push(serie); return m.enSerie(serie, fn); } };
});

// ⚠ ORDRE D'IMPORT (documenté dans `assistant/capability-audit.test.ts`) : `assistant` se charge le
// PREMIER, comme dans l'application — avant toute action qui, par la fabrique, remonterait le cycle
// d'initialisation `ops/index.ts` ↔ `lib/assistant.ts` par l'autre bout.
import "@/lib/assistant";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { faitsStock, peutRecevoirDuStock } from "@/lib/queries/promo-stock";
import { decouperActions } from "./contrat";
import { cancelPromoMaterial, submitQuotes, chooseAgency, initiatePayment, settle } from "./promo-material-actions";
import { genererBonsDeCommandePromo, validerEtEnvoyerBcPromo } from "./promo-execution-actions";
import { markQuoteReceived } from "./promo-circuit-actions";
import { reprendreRecurrenceComptage } from "./promo-comptage-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__restesr1__${Date.now().toString(36)}`;
const DEBUT = new Date();

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], nom, { type: "application/pdf" });
const entrees = (cle: string) => appelsFile.filter((k) => k === cle).length;

// ─────────────────────────── La barrière (§118.164e) ───────────────────────────

type Verrou = (tx: Prisma.TransactionClient) => Promise<unknown>;
const verrouDossier = (id: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "PromoMaterial" WHERE id = ${id} FOR UPDATE`;
const verrouDevis = (id: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "PromoQuote" WHERE id = ${id} FOR UPDATE`;
const verrouRecurrence = (id: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "PromoStockComptageRecurrence" WHERE id = ${id} FOR UPDATE`;

/**
 * Combien de sessions attendent derrière NOUS — directement, ou derrière une session que nous bloquons.
 * `pg_blocking_pids`, pas un filtre sur le texte des requêtes : un filtre compterait les gestes des autres
 * fichiers de la suite, et la barrière s'ouvrirait avant que les nôtres y soient (§118.193).
 */
async function bloquesParNous(tx: Prisma.TransactionClient): Promise<number> {
  await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    WITH att AS (SELECT pid, pg_blocking_pids(pid) AS par FROM pg_stat_activity WHERE datname = current_database()),
         directs AS (SELECT pid FROM att WHERE pg_backend_pid() = ANY(par))
    SELECT count(*)::int AS n FROM att
    WHERE pg_backend_pid() = ANY(par) OR par && ARRAY(SELECT pid FROM directs)`;
  return n;
}

/** Attend qu'une condition tienne ; un échec dit ce que faisaient les sessions. */
async function jusqua(tx: Prisma.TransactionClient, quoi: string, condition: () => boolean | Promise<boolean>, delai = 45_000): Promise<void> {
  const debut = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - debut > delai) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const vues = await tx.$queryRaw<{ etat: string | null; attente: string; requete: string }[]>`
        SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
      throw new Error(`${quoi} n'a pas atteint la barrière — ${JSON.stringify(vues)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Le banc tient une ligne le temps du scénario ; le relâcher, c'est terminer sa transaction. */
async function enTenant(verrou: Verrou, scenario: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await prisma.$transaction(async (tx) => { await verrou(tx); await scenario(tx); }, { timeout: 120_000, maxWait: 20_000 });
}

/** Un geste lancé dont on veut savoir, sans l'attendre, s'il a rendu la main. */
function lancer(geste: () => Promise<ActionResult>): { p: Promise<ActionResult>; fini: () => boolean } {
  let fini = false;
  const p = geste();
  p.then(() => { fini = true; }, () => { fini = true; });
  return { p, fini: () => fini };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RESTES DU MATÉRIEL PROMOTIONNEL (vague « restes », r1) — par les VRAIS points d'entrée.
 *
 *  1. Annuler un dossier annule sa demande au secrétariat par la porte COMMUNE (approbations,
 *     validations, paiement non réglé) — et une demande dont le paiement est réglé reste ouverte, dite.
 *  2. Annuler et générer les BC passent par la MÊME file : l'un passe, l'autre refuse, jamais les deux.
 *  3. L'ancien parcours (et la réception du devis au circuit 1) écrit sur la marche LUE ; ce qu'un
 *     geste perdu a préparé (pièces, ordre de dépense) est retiré.
 *  4. Reprendre une récurrence relit aussi la personne visée, et ne s'écrit qu'une fois.
 *
 *   dem   demandeuse (Promotion médicale, sans vue globale)   asst  assistante de direction
 *   med   information médicale                               fin   Finances
 *   ops   directeur des opérations (auteur des récurrences)  k1    délégué, a le stock
 *   sm    responsable réglementaire, N'A PAS le stock         val   validatrice d'une approbation
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — les restes : annulation commune, file des BC, marches conditionnelles, reprise", () => {
  const u: Record<string, string> = {};
  let companyId = "", fournisseur = "";

  async function nettoyer() {
    const pmIds = (await prisma.promoMaterial.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
    const reqIds = (await prisma.administrativeRequest.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id);
    const pieces = (await prisma.legalDocument.findMany({
      where: { OR: [...(companyId ? [{ companyId }] : []), { sourceType: "PROMO_MATERIAL", sourceId: { in: pmIds } }, { title: { startsWith: TAG } }] },
      select: { id: true },
    })).map((d) => d.id);
    const ordres = (await prisma.expenseOrder.findMany({
      where: { OR: [{ sourceType: "PROMO_MATERIAL", sourceId: { in: pmIds } }, { sourceType: "ADMIN_REQUEST", sourceId: { in: reqIds } }, { reference: { startsWith: TAG } }] },
      select: { id: true },
    })).map((o) => o.id);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({
      where: { OR: [{ entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }, { entityType: "ADMIN_REQUEST", entityId: { in: reqIds } }, { reference: { startsWith: TAG } }] },
      select: { id: true },
    })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    const docs = await prisma.document.findMany({
      where: { OR: [{ entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }, { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }] },
      select: { id: true },
    });
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.promoQuote.updateMany({ where: { promoMaterialId: { in: pmIds } }, data: { purchaseOrderId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { OR: [{ entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }, { entityType: "ADMIN_REQUEST", entityId: { in: reqIds } }] } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: reqIds } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: { in: pmIds } } }).catch(() => {});
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.promoStockComptageRecurrence.deleteMany({ where: { OR: [{ auteurId: { in: ids } }, { holderId: { in: ids } }] } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    if (companyId) await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    // Les avis partis vers des rôles (centre, Finances) portent le lien du dossier : bornés par la date (§118.175).
    const liens = [...pmIds, ...reqIds];
    if (liens.length) await prisma.notification.deleteMany({ where: { createdAt: { gte: DEBUT }, OR: liens.map((id) => ({ link: { contains: id } })) } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...pmIds, ...reqIds, ...pieces, ...ordres] } }] } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    if (companyId) {
      await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
      await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    }
  }

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([
      mk("dem", "MEDICAL_PROMOTION_MANAGER"), mk("asst", "DIRECTION_ASSISTANT"), mk("med", "MEDICAL_INFO_PHARMACIST"),
      mk("fin", "FINANCE_BUDGET_MANAGER"), mk("ops", "OPERATIONS_DIRECTOR"), mk("k1", "MEDICAL_DELEGATE"),
      mk("sm", "HEAD_OF_REGULATORY"), mk("val", "DIRECTION"),
    ]);
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } });
    companyId = c.id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    // La demandeuse est salariée de la société : c'est ce qui lui en ouvre la lecture, donc l'émission des
    // BC de son dossier sous délégation (§118.152a). L'équipe de ops : k1 (a le stock) et sm (ne l'a pas).
    const eOps = (await prisma.employee.create({ data: { fullName: `${TAG} ops`, userId: u.ops, companyId } })).id;
    await prisma.employee.create({ data: { fullName: `${TAG} dem`, userId: u.dem, companyId } });
    await prisma.employee.create({ data: { fullName: `${TAG} k1`, userId: u.k1, managerId: eOps, companyId } });
    await prisma.employee.create({ data: { fullName: `${TAG} sm`, userId: u.sm, managerId: eOps, companyId } });
    fournisseur = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Atlas`, address: "Zone industrielle", city: "Alger", rc: "16/00-111", nif: "0001", companyId: null } })).id;
  }, 60_000);

  afterAll(async () => { await nettoyer(); }, 120_000);

  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!); };
  let n = 0;
  const dossier = async (data: Partial<Prisma.PromoMaterialUncheckedCreateInput> = {}) => {
    n += 1;
    return (await prisma.promoMaterial.create({
      data: { reference: `${TAG}-${n}`, title: `${TAG} dossier ${n}`, requesterId: u.dem, companyId, ...data },
      select: { id: true },
    })).id;
  };
  /** Un dossier du circuit 2 EN EXÉCUTION : un devis, une ligne retenue, un fournisseur de l'annuaire. */
  const dossierEnExecution = async () => {
    const id = await dossier({ circuitVersion: 2, circuitState: "IN_EXECUTION" });
    const quote = await prisma.promoQuote.create({
      data: { promoMaterialId: id, supplierId: fournisseur, supplierName: `${TAG} Imprimerie Atlas`, reference: "D-26/01", lines: { create: [{ reference: "Brochure", unit: "pièce", quantity: 100, unitPrice: 50, selected: true, action: "IMPRESSION" }] } },
      select: { id: true },
    });
    return { id, quoteId: quote.id };
  };
  const demande = async (data: Partial<Prisma.AdministrativeRequestUncheckedCreateInput> = {}) => {
    n += 1;
    return (await prisma.administrativeRequest.create({
      data: { reference: `${TAG}-R${n}`, title: `${TAG} demande ${n}`, type: "QUOTE", status: "IN_PROGRESS", requesterId: u.dem, ...data },
      select: { id: true },
    })).id;
  };
  const ordre = async (data: Partial<Prisma.ExpenseOrderUncheckedCreateInput>) => {
    n += 1;
    return (await prisma.expenseOrder.create({ data: { reference: `${TAG}-OD${n}`, label: `${TAG} ordre ${n}`, amount: 1000, ...data }, select: { id: true } })).id;
  };
  const lire = (id: string) => prisma.promoMaterial.findUniqueOrThrow({
    where: { id }, select: { status: true, circuitState: true, chosenAgency: true, paymentOrderId: true, settlementOrderId: true },
  });
  const bcsActifs = async (pmId: string) => {
    const devis = await prisma.promoQuote.findMany({ where: { promoMaterialId: pmId, purchaseOrderId: { not: null } }, select: { purchaseOrderId: true } });
    return prisma.legalDocument.count({ where: { id: { in: devis.map((d) => d.purchaseOrderId!) }, status: { not: "CANCELLED" } } });
  };

  it("PRÉMISSES : la demandeuse n'a pas la vue globale ; ops fait compter son équipe, où k1 a le stock et sm ne l'a pas", async () => {
    expect(hasGlobalView((await actorFor(u.dem!)).role)).toBe(false);
    const f = await faitsStock(await actorFor(u.ops!));
    expect(f.directeurDesOperations && f.module.modifier).toBe(true);
    expect(f.equipe.has(u.k1!) && f.equipe.has(u.sm!)).toBe(true);
    expect((await peutRecevoirDuStock(u.k1!)).ok).toBe(true);
    expect((await peutRecevoirDuStock(u.sm!)).ok, "sinon le refus de la reprise ne prouverait rien").toBe(false);
  });

  // ─────────────────── 1. L'annulation commune de la demande au secrétariat ───────────────────

  it("ANNULER LE DOSSIER ANNULE SES DEMANDES AU SECRÉTARIAT PAR LA PORTE COMMUNE — approbation retirée, validation retirée, paiement non réglé annulé", async () => {
    const principale = await demande();
    const id = await dossier({ circuitVersion: 2, circuitState: "QUOTE_REQUESTED", adminRequestId: principale });
    // Une SECONDE demande encore ouverte sur le dossier (des devis redemandés, rouverte au bureau) part aussi.
    const liee = await demande({ linkedEntityType: "PROMO_MATERIAL", linkedEntityId: id });
    await prisma.adminApproval.create({ data: { requestId: principale, validatorId: u.val, requestedById: u.asst } });
    const validation = await prisma.validationRequest.create({
      data: { reference: `${TAG}-VAL`, module: "Bureau du secrétariat", title: `${TAG} validation`, requesterId: u.asst, entityType: "ADMIN_REQUEST", entityId: liee, steps: { create: [{ order: 1, validatorId: u.val }] } },
      select: { id: true },
    });
    const od = await ordre({ sourceType: "ADMIN_REQUEST", sourceId: principale, status: "PENDING", centralStatus: "AWAITING" });

    await comme("dem");
    const r = await cancelPromoMaterial(form({ id, motif: "Le congrès est reporté." }));
    expect(r.ok, r.error).toBe(true);
    expect((await lire(id)).status).toBe("CANCELLED");
    const demandes = await prisma.administrativeRequest.findMany({ where: { id: { in: [principale, liee] } }, select: { status: true } });
    expect(demandes.map((d) => d.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(await prisma.adminApproval.count({ where: { requestId: principale, status: "PENDING" } }), "une approbation en attente émettait un paiement pour un dossier annulé").toBe(0);
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: validation.id } })).status).toBe("CANCELLED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: od } })).status).toBe("CANCELLED");
    expect(r.message).toMatch(/est annulée avec lui/);
    // La validatrice de l'approbation retirée est prévenue — par le geste commun, pas par une copie.
    expect(await prisma.notification.count({ where: { userId: u.val, title: "Validation retirée" } })).toBeGreaterThanOrEqual(1);
  });

  it("UNE DEMANDE DONT LE PAIEMENT EST DÉJÀ RÉGLÉ RESTE OUVERTE — elle se termine — et la phrase rendue le DIT", async () => {
    const principale = await demande();
    const id = await dossier({ circuitVersion: 2, circuitState: "REVIEW_REQUESTER", adminRequestId: principale });
    await ordre({ sourceType: "ADMIN_REQUEST", sourceId: principale, status: "PAID", paidDate: new Date(), centralStatus: "APPROVED" });
    await comme("dem");
    const r = await cancelPromoMaterial(form({ id, motif: "Projet abandonné." }));
    expect(r.ok, r.error).toBe(true);
    expect((await lire(id)).status).toBe("CANCELLED");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: principale } })).status).toBe("IN_PROGRESS");
    expect(r.message).toMatch(/reste ouverte/);
    expect(r.message).toMatch(/déjà réglé/);
  });

  it("L'ANCIEN PARCOURS : l'ordre du bordereau qui attendait le centre part avec le dossier annulé", async () => {
    const od = await ordre({ sourceType: "PROMO_MATERIAL", status: "PENDING", centralStatus: "AWAITING" });
    const id = await dossier({ status: "PAYMENT_INITIATED", paymentOrderId: od });
    await prisma.expenseOrder.update({ where: { id: od }, data: { sourceId: id } });
    await comme("dem");
    const r = await cancelPromoMaterial(form({ id, motif: "Agence défaillante." }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: od } })).status, "il aurait payé l'agence d'un dossier annulé").toBe("CANCELLED");
    expect(r.message).toMatch(/est annulé/);
  });

  // ─────────────────── 2. Annuler et générer passent par la même file ───────────────────

  it("UN BC ANNULÉ DEPUIS SA FICHE LEGAL N'EMPÊCHE PLUS D'ANNULER LE DOSSIER — un BC actif, si", async () => {
    const actif = await dossierEnExecution();
    const bcActif = await prisma.legalDocument.create({ data: { title: `${TAG} BC actif`, kind: "PURCHASE_ORDER", status: "ACTIVE", sourceType: "PROMO_MATERIAL", sourceId: actif.id, companyId }, select: { id: true } });
    await prisma.promoQuote.update({ where: { id: actif.quoteId }, data: { purchaseOrderId: bcActif.id } });
    await comme("dem");
    const refus = await cancelPromoMaterial(form({ id: actif.id, motif: "Test" }));
    expect(refus.error ?? "").toMatch(/1 bon de commande a été généré/);

    const annule = await dossierEnExecution();
    const bcAnnule = await prisma.legalDocument.create({ data: { title: `${TAG} BC annulé`, kind: "PURCHASE_ORDER", status: "CANCELLED", sourceType: "PROMO_MATERIAL", sourceId: annule.id, companyId }, select: { id: true } });
    await prisma.promoQuote.update({ where: { id: annule.quoteId }, data: { purchaseOrderId: bcAnnule.id } });
    const r = await cancelPromoMaterial(form({ id: annule.id, motif: "Commande abandonnée." }));
    expect(r.ok, `un BC annulé n'est plus une commande engagée — ${r.error}`).toBe(true);
  });

  it("UNE GÉNÉRATION LANCÉE, PUIS UNE ANNULATION : le BC part et l'annulation est refusée — jamais les deux", async () => {
    const { id, quoteId } = await dossierEnExecution();
    const dem = await actorFor(u.dem!);
    // L'APERÇU D'ABORD (Direction, 10/2026) : la génération dépose l'aperçu ; c'est sa VALIDATION par le demandeur qui émet.
    ACTOR = dem;
    const apercu = await genererBonsDeCommandePromo(form({ promoMaterialId: id }));
    expect(apercu.ok, apercu.error).toBe(true);
    expect(await bcsActifs(id), "un aperçu n'émet rien").toBe(0);
    let gen!: ReturnType<typeof lancer>, annul!: ReturnType<typeof lancer>;
    // Le banc tient le DEVIS : la validation émet le BC, puis attend à l'écriture qui le lie au devis.
    await enTenant(verrouDevis(quoteId), async (tx) => {
      ACTOR = dem; gen = lancer(() => validerEtEnvoyerBcPromo(form({ promoMaterialId: id, quoteId })));
      await jusqua(tx, "la génération", async () => (await bloquesParNous(tx)) >= 1);
      const avant = entrees(`promo-bc:${id}`);
      ACTOR = dem; annul = lancer(() => cancelPromoMaterial(form({ id, motif: "Croisement." })));
      // L'annulation doit être dans la file (le code juste) — ou avoir déjà rendu la main (le défaut).
      await jusqua(tx, "l'annulation", () => annul.fini() || entrees(`promo-bc:${id}`) > avant);
    });
    const [g, a] = [await gen.p, await annul.p];
    expect([g.ok, a.ok].filter(Boolean), JSON.stringify([g, a])).toHaveLength(1);
    expect(g.ok, g.error).toBe(true);
    expect(a.error ?? "").toMatch(/bon de commande a été généré/);
    expect((await lire(id)).status).not.toBe("CANCELLED");
    expect(await bcsActifs(id)).toBe(1);
  }, 180_000);

  it("UNE ANNULATION, PUIS UNE GÉNÉRATION MISE EN FILE AVANT SON ÉCRITURE : l'annulation passe, la génération RELIT le dossier et refuse", async () => {
    const { id } = await dossierEnExecution();
    const dem = await actorFor(u.dem!);
    let gen!: ReturnType<typeof lancer>, annul!: ReturnType<typeof lancer>;
    // Le banc tient le DOSSIER : l'annulation, dans la file, attend à son écriture.
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = dem; annul = lancer(() => cancelPromoMaterial(form({ id, motif: "Croisement inverse." })));
      await jusqua(tx, "l'annulation", async () => (await bloquesParNous(tx)) >= 1);
      const avant = entrees(`promo-bc:${id}`);
      // La génération lit un dossier encore en exécution, et entre dans la file derrière l'annulation.
      ACTOR = dem; gen = lancer(() => genererBonsDeCommandePromo(form({ promoMaterialId: id })));
      await jusqua(tx, "la génération", () => entrees(`promo-bc:${id}`) > avant);
    });
    const [a, g] = [await annul.p, await gen.p];
    expect([g.ok, a.ok].filter(Boolean), JSON.stringify([a, g])).toHaveLength(1);
    expect(a.ok, a.error).toBe(true);
    expect(g.error ?? "").toMatch(/a été annulé/);
    expect(await bcsActifs(id), "un BC vivant sur un dossier annulé").toBe(0);
    expect(await prisma.legalDocument.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: id, kind: "PURCHASE_ORDER" } })).toBe(0);
  }, 180_000);

  // ─────────────────── 3. L'ancien parcours écrit sur la marche lue ───────────────────

  it("RÈGLE DE POINT D'APPEL : aucune écriture de l'ancien parcours (ni la réception du devis, ni la reprise) n'écrit sans condition", () => {
    const source = (f: string) => readFileSync(join(process.cwd(), "src/lib/actions", f), "utf8");
    const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const materiel = sansCommentaires(source("promo-material-actions.ts"));
    expect(materiel.match(/\b(?:prisma|tx)\.promoMaterial\.update\(/g), "une marche écrite par son seul identifiant").toBeNull();
    const ecritures = [...materiel.matchAll(/\b(?:prisma|tx)\.promoMaterial\.updateMany\(\{([\s\S]*?)\bdata:/g)].map((m) => m[1]);
    // Plancher : les quatorze marches, la relance, le lien de l'ordre de règlement, l'annulation.
    expect(ecritures.length, "un parcours cassé rendrait ce cliquet vert en ne lisant rien").toBeGreaterThanOrEqual(17);
    for (const w of ecritures) expect(w, `écriture sans marche lue : ${w}`).toMatch(/surLaMarcheLue\(|status:/);
    expect(materiel.match(/\b(?:prisma|tx)\.administrativeRequest\.update\(/g), "une demande au secrétariat changée par son seul identifiant").toBeNull();

    const actionsMateriel = decouperActions("promo-material-actions.ts", source("promo-material-actions.ts"));
    const annulation = actionsMateriel.find((a) => a.fonction === "cancelPromoMaterial")!;
    expect(annulation.corps).toMatch(/annulerDemandeSecretariat\(/);
    expect(annulation.corps).toMatch(/enSerie\(`promo-bc:\$\{id\}`/);

    const reception = decouperActions("promo-circuit-actions.ts", source("promo-circuit-actions.ts")).find((a) => a.fonction === "markQuoteReceived")!;
    expect(reception.corps).not.toMatch(/promoMaterial\.update\(/);
    expect(reception.corps).toMatch(/promoMaterial\.updateMany\(\{\s*where: \{ id, circuitState: "QUOTE_REQUESTED"/);

    const reprise = decouperActions("promo-comptage-actions.ts", source("promo-comptage-actions.ts")).find((a) => a.fonction === "reprendreRecurrenceComptage")!;
    expect(reprise.corps).not.toMatch(/Recurrence\.update\(/);
    expect(reprise.corps).toMatch(/where: \{ id: r\.id, actif: false \}/);

    // LA GÉNÉRATION EST UNE (§118.204) : le geste de repli et la génération automatique à la dernière
    // validation passent par `genererLesBonsDeCommande` — c'est là que le dossier se relit DANS la file, et
    // que le lien devis → BC s'écrit sur ce qui a été lu, jamais par le seul identifiant du devis.
    const generation = decouperActions("promo-execution-actions.ts", source("promo-execution-actions.ts")).find((a) => a.fonction === "genererBonsDeCommandePromo")!;
    expect(generation.corps).toMatch(/genererLesBonsDeCommande\(user, pm\.id,/);
    const coeur = sansCommentaires(readFileSync(join(process.cwd(), "src/lib/promo-automatismes.ts"), "utf8"));
    const dansLaFile = coeur.slice(coeur.indexOf("enSerie(`promo-bc:"));
    expect(dansLaFile, "prémisse : la génération passe par la file").not.toBe(coeur);
    expect(dansLaFile, "le dossier se relit DANS la file").toMatch(/promoMaterial\.findUnique\([\s\S]*?refusEtatGeneration\(pm\)/);
    expect(coeur.match(/\bpromoQuote\.update\(/g), "un devis recousu à son BC par son seul identifiant").toBeNull();
    expect(dansLaFile).toMatch(/promoQuote\.updateMany\(\{\s*where: \{ id: d\.id, purchaseOrderId: brut\.purchaseOrderId \?\? null, promoMaterial: \{ circuitVersion: 2, circuitState: "IN_EXECUTION" \}/);
  });

  it("DEUX « DEVIS DÉPOSÉS » CROISÉS : une seule marche s'écrit, l'autre dit que le dossier a changé — un seul avis au demandeur", async () => {
    const id = await dossier({ status: "PROSPECTION_REQUESTED" });
    const asst = await actorFor(u.asst!);
    let a!: ReturnType<typeof lancer>, b!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = asst; a = lancer(() => submitQuotes(form({ id })));
      ACTOR = asst; b = lancer(() => submitQuotes(form({ id })));
      await jusqua(tx, "les deux dépôts", async () => (await bloquesParNous(tx)) >= 2);
    });
    const [ra, rb] = [await a.p, await b.p];
    expect([ra.ok, rb.ok].filter(Boolean), JSON.stringify([ra, rb])).toHaveLength(1);
    expect((ra.ok ? rb : ra).error).toMatch(/vient de changer d'état/);
    expect(await prisma.notification.count({ where: { userId: u.dem, title: { contains: "devis disponibles" }, link: { contains: id } } })).toBe(1);
  });

  it("UN DOSSIER BASCULÉ AU NOUVEAU CIRCUIT PENDANT UNE MARCHE DE L'ANCIEN ne la reçoit pas — la condition porte aussi la version", async () => {
    const id = await dossier({ status: "PROSPECTION_REQUESTED" });
    const asst = await actorFor(u.asst!);
    let g!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = asst; g = lancer(() => submitQuotes(form({ id })));
      await jusqua(tx, "le dépôt", async () => (await bloquesParNous(tx)) >= 1);
      // Le demandeur bascule le dossier au circuit 2 pendant ce temps (`startPromoCircuit` ne touche pas au statut).
      await tx.promoMaterial.update({ where: { id }, data: { circuitVersion: 2, circuitState: "REVIEW_REQUEST" } });
    });
    const r = await g.p;
    expect(r.error ?? "").toMatch(/vient de changer d'état/);
    expect((await lire(id)).status, "une marche de l'ancien parcours sur un dossier du circuit 2").toBe("PROSPECTION_REQUESTED");
  });

  it("UN CHOIX D'AGENCE QUI PERD LA COURSE n'écrase pas l'agence retenue, et RETIRE ses pièces jointes", async () => {
    const id = await dossier({ status: "QUOTES_UPLOADED" });
    const dem = await actorFor(u.dem!);
    let g!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = dem; g = lancer(() => chooseAgency(form({ id, chosenAgency: "Agence A", attachments: pdf(`${TAG}-comparatif.pdf`) })));
      await jusqua(tx, "le choix", async () => (await bloquesParNous(tx)) >= 1);
      // Un autre choix l'emporte pendant que celui-ci attend (le détenteur du verrou écrit lui-même).
      await tx.promoMaterial.update({ where: { id }, data: { status: "AGENCY_CHOSEN", chosenAgency: "Agence B" } });
    });
    const r = await g.p;
    expect(r.error ?? "").toMatch(/vient de changer d'état/);
    expect((await lire(id)).chosenAgency).toBe("Agence B");
    expect(await prisma.document.count({ where: { entityType: "PROMO_MATERIAL", entityId: id, stepKey: "agency_choice" } }), "une pièce que personne ne retrouve à sa place").toBe(0);
    expect(await prisma.comment.count({ where: { entityType: "PROMO_MATERIAL", entityId: id, body: { startsWith: "Agence retenue" } } })).toBe(0);
  });

  it("DEUX BORDEREAUX À LA MÊME SECONDE : un seul ordre de dépense part au centre de paiement", async () => {
    const id = await dossier({ status: "BC_SENT", chosenAgency: "Agence A", chosenAmount: 50_000 });
    const med = await actorFor(u.med!);
    let a!: ReturnType<typeof lancer>, b!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = med; a = lancer(() => initiatePayment(form({ id })));
      await jusqua(tx, "le premier bordereau", async () => (await bloquesParNous(tx)) >= 1);
      ACTOR = med; b = lancer(() => initiatePayment(form({ id })));
      // Le second attend dans la file (le code juste) — ou à l'écriture, son propre ordre déjà créé (le défaut).
      await jusqua(tx, "le second bordereau", async () => entrees(`promo-bordereau:${id}`) >= 2 || (await bloquesParNous(tx)) >= 2);
    });
    const [ra, rb] = [await a.p, await b.p];
    expect([ra.ok, rb.ok].filter(Boolean), JSON.stringify([ra, rb])).toHaveLength(1);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: id } }), "un ordre créé pour rien, même annulé ensuite").toBe(1);
    expect((ra.ok ? rb : ra).error).toMatch(/déjà initié/);
  }, 60_000);

  it("ENTRE DEUX PROCESSUS, le bordereau perdant annule l'ordre qu'il venait de préparer, et n'écrase pas l'ordre du gagnant", async () => {
    const id = await dossier({ status: "BC_SENT", chosenAgency: "Agence A", chosenAmount: 50_000 });
    const med = await actorFor(u.med!);
    const autre = await ordre({ status: "PENDING", centralStatus: "AWAITING" });
    let g!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = med; g = lancer(() => initiatePayment(form({ id })));
      await jusqua(tx, "le bordereau", async () => (await bloquesParNous(tx)) >= 1);
      await tx.promoMaterial.update({ where: { id }, data: { status: "PAYMENT_INITIATED", paymentOrderId: autre } });
    });
    const r = await g.p;
    expect(r.error ?? "").toMatch(/vient de changer d'état.*est annulé/s);
    expect((await lire(id)).paymentOrderId).toBe(autre);
    const prepare = await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "PROMO_MATERIAL", sourceId: id } });
    expect(prepare.status, "un ordre payable qu'aucun dossier ne désigne").toBe("CANCELLED");
  }, 60_000);

  it("DEUX RÈGLEMENTS À LA MÊME SECONDE : un seul ordre de règlement part au centre — le second relit le dossier", async () => {
    const id = await dossier({ status: "INVOICED", chosenAgency: "Agence A", chosenAmount: 50_000 });
    const fin = await actorFor(u.fin!);
    let a!: ReturnType<typeof lancer>, b!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = fin; a = lancer(() => settle(form({ id, amount: "50000" })));
      await jusqua(tx, "le premier règlement", async () => (await bloquesParNous(tx)) >= 1);
      ACTOR = fin; b = lancer(() => settle(form({ id, amount: "50000" })));
      await jusqua(tx, "le second règlement", async () => entrees(`promo-reglement:${id}`) >= 2 || (await bloquesParNous(tx)) >= 2);
    });
    const [ra, rb] = [await a.p, await b.p];
    expect([ra.ok, rb.ok].filter(Boolean), JSON.stringify([ra, rb])).toHaveLength(1);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: id } }), "un ordre créé pour rien, même annulé ensuite").toBe(1);
    // Le second a trouvé l'ordre du premier : il en est au second temps, qui attend que cet ordre soit réglé.
    expect((ra.ok ? rb : ra).error).toMatch(/centre de paiement|réglé/);
  }, 60_000);

  it("LE RÈGLEMENT : le perdant annule son ordre ; la clôture ne termine pas une demande au secrétariat ANNULÉE", async () => {
    const id = await dossier({ status: "INVOICED", chosenAgency: "Agence A", chosenAmount: 50_000 });
    const fin = await actorFor(u.fin!);
    const autre = await ordre({ status: "PENDING", centralStatus: "AWAITING" });
    let g!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = fin; g = lancer(() => settle(form({ id, amount: "50000" })));
      await jusqua(tx, "le règlement", async () => (await bloquesParNous(tx)) >= 1);
      await tx.promoMaterial.update({ where: { id }, data: { settlementOrderId: autre } });
    });
    const r = await g.p;
    expect(r.error ?? "").toMatch(/vient de changer d'état.*est annulé/s);
    expect((await lire(id)).settlementOrderId).toBe(autre);
    expect((await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "PROMO_MATERIAL", sourceId: id } })).status).toBe("CANCELLED");

    // La clôture : l'ordre réglé, la demande liée annulée entre-temps — elle ne repasse pas « terminée ».
    const annulee = await demande({ status: "CANCELLED" });
    const regle = await ordre({ status: "PAID", paidDate: new Date(), centralStatus: "APPROVED" });
    const id2 = await dossier({ status: "INVOICED", settlementOrderId: regle, adminRequestId: annulee });
    ACTOR = fin;
    const clos = await settle(form({ id: id2 }));
    expect(clos.ok, clos.error).toBe(true);
    expect((await lire(id2)).status).toBe("SETTLED");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: annulee } })).status).toBe("CANCELLED");
  }, 60_000);

  it("CIRCUIT 1 — DEUX « DEVIS REÇU » CROISÉS : une seule réception s'écrit, l'autre dit que le dossier a changé d'étape", async () => {
    const id = await dossier({ circuitVersion: 1, circuitState: "QUOTE_REQUESTED" });
    await prisma.document.create({ data: { name: `${TAG}-devis.pdf`, entityType: "PROMO_MATERIAL", entityId: id, uploadedById: u.dem } });
    const dem = await actorFor(u.dem!);
    let a!: ReturnType<typeof lancer>, b!: ReturnType<typeof lancer>;
    await enTenant(verrouDossier(id), async (tx) => {
      ACTOR = dem; a = lancer(() => markQuoteReceived(form({ id })));
      ACTOR = dem; b = lancer(() => markQuoteReceived(form({ id })));
      await jusqua(tx, "les deux réceptions", async () => (await bloquesParNous(tx)) >= 2);
    });
    const [ra, rb] = [await a.p, await b.p];
    expect([ra.ok, rb.ok].filter(Boolean), JSON.stringify([ra, rb])).toHaveLength(1);
    expect((ra.ok ? rb : ra).error).toMatch(/vient de changer d'étape/);
    expect(await prisma.auditLog.count({ where: { entityId: id, summary: { startsWith: "Devis reçu" } } })).toBe(1);
  });

  // ─────────────────── 4. Reprendre une récurrence ───────────────────

  const recurrence = (holderId: string) => prisma.promoStockComptageRecurrence.create({
    data: {
      cible: "PERSONNE", holderId, frequence: "MENSUEL", ancreLe: new Date(Date.now() - 40 * 86_400_000), prochaineLe: new Date(Date.now() - 86_400_000),
      auteurId: u.ops, actif: false, pauseLe: new Date(), pauseMotif: "Suspendue pour le banc.",
    },
    select: { id: true },
  }).then((r) => r.id);

  it("REPRENDRE UNE RÉCURRENCE DONT LA PERSONNE N'A PLUS LE STOCK : refusé, elle reste suspendue — la même, vers k1, reprend", async () => {
    await comme("ops");
    const sansStock = await recurrence(u.sm!);
    const r = await reprendreRecurrenceComptage(form({ recurrenceId: sansStock }));
    expect(r.error ?? "").toMatch(/n'a pas accès au stock promotionnel.*reste suspendue/s);
    expect((await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: sansStock } })).actif).toBe(false);
    // Le TÉMOIN : la même récurrence, vers quelqu'un qui a le stock, reprend.
    const avecStock = await recurrence(u.k1!);
    const ok = await reprendreRecurrenceComptage(form({ recurrenceId: avecStock }));
    expect(ok.ok, ok.error).toBe(true);
    expect((await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: avecStock } })).actif).toBe(true);
  });

  it("DEUX REPRISES CROISÉES n'en écrivent qu'une ; une récurrence supprimée pendant la reprise répond par une phrase", async () => {
    const ops = await actorFor(u.ops!);
    const rid = await recurrence(u.k1!);
    let a!: ReturnType<typeof lancer>, b!: ReturnType<typeof lancer>;
    await enTenant(verrouRecurrence(rid), async (tx) => {
      ACTOR = ops; a = lancer(() => reprendreRecurrenceComptage(form({ recurrenceId: rid })));
      ACTOR = ops; b = lancer(() => reprendreRecurrenceComptage(form({ recurrenceId: rid })));
      await jusqua(tx, "les deux reprises", async () => (await bloquesParNous(tx)) >= 2);
    });
    const [ra, rb] = [await a.p, await b.p];
    expect([ra.ok, rb.ok].filter(Boolean), JSON.stringify([ra, rb])).toHaveLength(1);
    expect((ra.ok ? rb : ra).error).toMatch(/vient d'être reprise ou supprimée/);
    expect(await prisma.auditLog.count({ where: { entityId: rid, summary: { startsWith: "Comptage récurrent repris" } } })).toBe(1);

    const supprimee = await recurrence(u.k1!);
    let g!: ReturnType<typeof lancer>;
    await enTenant(verrouRecurrence(supprimee), async (tx) => {
      ACTOR = ops; g = lancer(() => reprendreRecurrenceComptage(form({ recurrenceId: supprimee })));
      await jusqua(tx, "la reprise", async () => (await bloquesParNous(tx)) >= 1);
      await tx.promoStockComptageRecurrence.delete({ where: { id: supprimee } });
    });
    const r = await g.p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vient d'être reprise ou supprimée/);
  });
});
