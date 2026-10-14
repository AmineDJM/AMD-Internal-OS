import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  createPromoMaterial, submitQuotes, chooseAgency, submitBcForFinance, validateBc, confirmBcSent,
  initiatePayment, confirmPayment, submitMaterial, directionReview, confirmConformity, startBat,
  submitFinalMaterial, recordInvoice, settle,
} from "./promo-material-actions";
import { decidePayment } from "./payment-centre-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__promotest__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
function form(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

suite("Matériel promotionnel — circuit complet (Marketing → Assistante → Finances → Info médicale → Direction)", () => {
  let mkt = "", asst = "", fin = "", med = "", dir = "", dg = "", pmId = "", article = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [a, b, c, d, e, g] = await Promise.all([
      mk("mkt", "MEDICAL_PROMOTION_MANAGER"),
      mk("asst", "DIRECTION_ASSISTANT"),
      mk("fin", "FINANCE_BUDGET_MANAGER"),
      mk("med", "MEDICAL_INFO_PHARMACIST"),
      mk("dir", "DIRECTION"),
      // LE CENTRE DE VALIDATION AD & PRO (§118.148) — c'est lui, et plus les Finances, qui
      // valide le BC. Le Directeur Général y siège.
      mk("dg", "GENERAL_MANAGER"),
    ]);
    mkt = a.id; asst = b.id; fin = c.id; med = d.id; dir = e.id; dg = g.id;
    // UNE DEMANDE NAÎT AVEC SES LIGNES (§118.171) : il faut un article du catalogue à demander. Le TAG
    // de ce banc est FIXE — un run interrompu laisse l'article, d'où l'upsert plutôt qu'une création.
    article = (await prisma.promoCatalogueArticle.upsert({
      where: { reference: `${TAG}ART` },
      update: { actif: true },
      create: { reference: `${TAG}ART`, nom: `${TAG} Brochure`, famille: "CONSOMMABLE" },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    // `PaymentRequest` ne porte que l'IDENTIFIANT de son ordre, pas la relation : on lit les ordres
    // d'abord. Écrit sous forme de relation, le filtre était refusé par Prisma — et le `.catch`
    // l'avalait, laissant les dossiers compagnons en base à chaque passage.
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId }, select: { id: true } })).map((o) => o.id);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "PROMO_MATERIAL", entityId: pmId } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: "MP-" }, title: { contains: TAG } } }).catch(() => {});
    // Les lignes demandées sont parties avec leur dossier (Cascade) : l'article ne les retient plus.
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("Marketing crée la demande de prospection", async () => {
    ACTOR = await actorFor(mkt, "MEDICAL_PROMOTION_MANAGER");
    const r = await createPromoMaterial(undefined, form({
      title: `Brochure ${TAG}`,
      lignes: JSON.stringify([{ catalogueId: article, quantite: "2000", actions: ["IMPRESSION"], produitIds: [], commentaire: "" }]),
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    pmId = r.id!;
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } });
    expect(pm.status).toBe("PROSPECTION_REQUESTED");
    expect(pm.requesterId).toBe(mkt);

    // UNE DEMANDE NEUVE NAÎT SUR LE CIRCUIT 2 (§118.152) — et les gestes de CE banc la refusent,
    // à raison : elle se pilote depuis « Suivi du circuit ». Ce banc garde ce qu'il a toujours
    // gardé, le circuit d'AVANT, que servent encore les dossiers ouverts avant la bascule. Le
    // dossier est donc ramené à ce que la création d'alors produisait (version 1, devis à
    // demander) : c'est l'état exact d'un dossier en vol en production, pas un raccourci de banc.
    expect(pm.circuitVersion, "une demande neuve naît sur le circuit par devis retranscrits").toBe(2);
    // La création d'alors portait aussi l'assistante désignée et un budget estimé, que le
    // formulaire ne demande plus (§118.171) : un dossier en vol les a, donc le banc les remet.
    await prisma.promoMaterial.update({ where: { id: pmId }, data: { circuitVersion: 1, circuitState: "QUOTE_REQUESTED", assistantId: asst, amount: 120000 } });
  });

  it("un acteur hors rôle ne peut pas faire avancer l'étape", async () => {
    ACTOR = await actorFor(fin, "FINANCE_BUDGET_MANAGER");
    const r = await submitQuotes(form({ id: pmId })); // c'est à l'assistante, pas aux finances
    expect(r.ok).toBe(false);
  });

  it("Assistante dépose les devis → Marketing choisit l'agence → Assistante transmet le BC", async () => {
    ACTOR = await actorFor(asst, "DIRECTION_ASSISTANT");
    expect((await submitQuotes(form({ id: pmId }))).ok).toBe(true);

    ACTOR = await actorFor(mkt, "MEDICAL_PROMOTION_MANAGER");
    expect((await chooseAgency(form({ id: pmId, chosenAgency: "Agence Pub DZ", chosenAmount: "118000" }))).ok).toBe(true);

    ACTOR = await actorFor(asst, "DIRECTION_ASSISTANT");
    expect((await submitBcForFinance(form({ id: pmId, bcReference: "BC-2026-9" }))).ok).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } });
    expect(pm.status).toBe("BC_FINANCE_REVIEW");
    expect(pm.chosenAgency).toBe("Agence Pub DZ");
  });

  it("le CENTRE DE VALIDATION AD & PRO valide le BC — plus les Finances (§118.148) → Assistante le transmet", async () => {
    // L'ancien validateur est REFUSÉ, et le refus nomme le centre : un BC né d'Ad & Pro passe par
    // le centre de validation Ad & Pro, décision de la Direction.
    ACTOR = await actorFor(fin, "FINANCE_BUDGET_MANAGER");
    const refus = await validateBc(form({ id: pmId }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/centre de validation Ad & Pro/i);

    ACTOR = await actorFor(dg, "GENERAL_MANAGER");
    expect((await validateBc(form({ id: pmId }))).ok).toBe(true);
    ACTOR = await actorFor(asst, "DIRECTION_ASSISTANT");
    expect((await confirmBcSent(form({ id: pmId }))).ok).toBe(true);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } })).status).toBe("BC_SENT");
  });

  it("Info médicale initie le bordereau → l'ordre attend le CENTRE DE PAIEMENT → payé → paiement constaté", async () => {
    ACTOR = await actorFor(med, "MEDICAL_INFO_PHARMACIST");
    expect((await initiatePayment(form({ id: pmId }))).ok).toBe(true);
    const pmAfter = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } });
    expect(pmAfter.status).toBe("PAYMENT_INITIATED");
    expect(pmAfter.paymentOrderId).toBeTruthy();
    const orders = await prisma.expenseOrder.findMany({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId } });
    expect(orders).toHaveLength(1);
    expect(orders[0].centralStatus).toBe("AWAITING");

    // « PAIEMENT EFFECTUÉ » NE SE DÉCLARE PAS sur un ordre qui attend le centre (§118.148) : le
    // dossier passait à PAYMENT_DONE pendant que l'argent n'était pas parti.
    ACTOR = await actorFor(fin, "FINANCE_BUDGET_MANAGER");
    const avant = await confirmPayment(form({ id: pmId, comment: "Réglé par virement" }));
    expect(avant.ok).toBe(false);
    expect(avant.error).toMatch(/centre de paiement/i);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } })).status).toBe("PAYMENT_INITIATED");

    // Le centre autorise (vrai point d'entrée), puis l'ordre est réglé.
    ACTOR = await actorFor(dir, "DIRECTION");
    expect((await decidePayment(form({ id: orders[0].id, decision: "APPROVE" }))).ok).toBe(true);
    ACTOR = await actorFor(fin, "FINANCE_BUDGET_MANAGER");
    const autorise = await confirmPayment(form({ id: pmId }));
    expect(autorise.ok, "autorisé n'est pas payé : l'ordre doit être RÉGLÉ").toBe(false);
    await prisma.expenseOrder.update({ where: { id: orders[0].id }, data: { status: "PAID", paidDate: new Date() } });

    expect((await confirmPayment(form({ id: pmId, comment: "Réglé par virement" }))).ok).toBe(true);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } })).status).toBe("PAYMENT_DONE");
  });

  it("Marketing dépose le matériel → Direction valide → Info médicale obtient le visa", async () => {
    ACTOR = await actorFor(mkt, "MEDICAL_PROMOTION_MANAGER");
    expect((await submitMaterial(form({ id: pmId }))).ok).toBe(true);
    ACTOR = await actorFor(dir, "DIRECTION");
    expect((await directionReview(form({ id: pmId, comment: "Conforme à la charte" }))).ok).toBe(true);
    ACTOR = await actorFor(med, "MEDICAL_INFO_PHARMACIST");
    expect((await confirmConformity(form({ id: pmId, visaReference: "VISA-2026-42", authorityRef: "DEP-77" }))).ok).toBe(true);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } })).status).toBe("VISA_OBTAINED");
  });

  it("Marketing imprime → matériel final → facture → Finances règlent (clôture)", async () => {
    ACTOR = await actorFor(mkt, "MEDICAL_PROMOTION_MANAGER");
    expect((await startBat(form({ id: pmId }))).ok).toBe(true);
    expect((await submitFinalMaterial(form({ id: pmId }))).ok).toBe(true);
    ACTOR = await actorFor(asst, "DIRECTION_ASSISTANT");
    expect((await recordInvoice(form({ id: pmId }))).ok).toBe(true);

    // DEUX TEMPS (§118.148) : le premier crée l'ordre — il part au centre, le dossier reste
    // « facturé » ; la clôture attend l'ordre RÉGLÉ.
    ACTOR = await actorFor(fin, "FINANCE_BUDGET_MANAGER");
    const envoi = await settle(form({ id: pmId, amount: "118000" }));
    expect(envoi.ok).toBe(true);
    expect(envoi.message).toMatch(/centre de paiement/i);
    let pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } });
    expect(pm.status, "un ordre qui attend le centre ne clôt pas le dossier").toBe("INVOICED");
    expect(pm.settlementOrderId).toBeTruthy();

    const trop = await settle(form({ id: pmId }));
    expect(trop.ok).toBe(false);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } })).status).toBe("INVOICED");
    // Un second clic ne crée pas un second ordre.
    expect(await prisma.expenseOrder.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId } })).toBe(2);

    await prisma.expenseOrder.update({ where: { id: pm.settlementOrderId! }, data: { centralStatus: "APPROVED", status: "PAID", paidDate: new Date() } });
    expect((await settle(form({ id: pmId }))).ok).toBe(true);
    pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } });
    expect(pm.status).toBe("SETTLED");
    const orders = await prisma.expenseOrder.findMany({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId } });
    expect(orders).toHaveLength(2); // bordereau de paiement + règlement final
  });
});
