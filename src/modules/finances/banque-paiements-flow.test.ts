import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { natureDe } from "@/lib/espace/aujourdhui";
import { lignesQuestionsDesFinances } from "@/lib/queries/action-center-questions-finances";
import { chargerOrdresDesFinances, chargerDossiersDesLignes, chargerTresorerie, rappelerQuestionsSansReponse } from "./api";
import { settleExpenseOrder } from "./actions-depenses";
import { addPaymentPiece, addPaymentComment } from "./actions-demandes";
import { ouvrirActualisationSoldes } from "./actions-soldes";
import { poserQuestionAuDemandeur, relancerQuestionDemandeur, marquerReponseLue, repondreAuxFinances } from "./actions-questions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BANQUE & PAIEMENTS (Super Admin, 24/11/2026) — les défauts corrigés et le circuit de la question, EN BASE.
 *
 *   • un ordre REFUSÉ par le centre n'arrive pas aux Finances : ni en ligne, ni dans « à payer » de la trésorerie ;
 *   • le règlement écrit la date, le mode et la référence saisis ; une date future est refusée ;
 *   • une remise de caisse se règle sans budget, en espèces, à la date saisie ;
 *   • la question : Finances → notification + ligne « Aujourd'hui » du demandeur → réponse avec pièce (rangée au
 *     dossier) → notification des Finances → « Réponse reçue » → lue ; rappel automatique idempotent ; relances visibles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__banquePaiements__${Date.now().toString(36)}`;
const fd = (o: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access: await getAccess(id, role), mustChangePassword: false };
}

suite("Banque & paiements — défauts et circuit de la question", () => {
  let societe = "", comptableId = "", demandeurId = "", deptId = "", envId = "", catId = "";
  let comptable: CurrentUser, demandeur: CurrentUser;
  const ordres: Record<string, string> = {};
  let dossierId = "";

  const ordre = async (cle: string, data: Partial<{ centralStatus: string; amount: number; beneficiary: string }> = {}) => {
    ordres[cle] = (await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}-${cle}`, label: `${TAG} ${cle}`, amount: data.amount ?? 10_000, beneficiary: data.beneficiary ?? `${TAG} Fournisseur`,
        companyId: societe, status: "PENDING", centralStatus: data.centralStatus ?? "APPROVED", requestedById: demandeurId,
      },
      select: { id: true },
    })).id;
    return ordres[cle];
  };

  beforeAll(async () => {
    societe = (await prisma.company.create({ data: { name: `${TAG}Société`, shortName: TAG.slice(0, 20) } })).id;
    comptableId = (await prisma.user.create({ data: { name: `${TAG} comptable`, email: `${TAG}cpt@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x", companyAccess: { create: [{ companyId: societe, canEdit: true }] } } })).id;
    demandeurId = (await prisma.user.create({ data: { name: `${TAG} demandeur`, email: `${TAG}dem@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" } })).id;
    comptable = await acteur(comptableId, "FINANCE_BUDGET_MANAGER");
    demandeur = await acteur(demandeurId, "PRODUCT_MANAGER");
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Env`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1_000_000 } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Cat`, allocated: 1_000_000 } })).id;
    deptId = (await prisma.department.create({ data: { name: `${TAG} Dépt`, code: TAG.slice(-12) } })).id;
    await ordre("refuse", { centralStatus: "REFUSED", amount: 777_000 });
    await ordre("autorise", { amount: 50_000 });
    await ordre("regle");
    await ordre("remise", { amount: 20_000 });
    await prisma.pettyCashAllotment.create({ data: { departmentId: deptId, period: "2026-11", amount: 20_000, expenseOrderId: ordres.remise } });
    // Le dossier compagnon de l'ordre autorisé : c'est son fil qui porte les échanges.
    dossierId = (await prisma.paymentRequest.create({
      data: {
        reference: `${TAG}-PAY`, title: `${TAG} stand`, amount: 50_000, payee: `${TAG} Fournisseur`, status: "SUBMITTED",
        requesterId: demandeurId, companyId: societe, expenseOrderId: ordres.autorise, origin: "EXPENSE_ORDER", submittedAt: new Date(),
      },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    await prisma.demandeActualisationSoldes.deleteMany({ where: { companyId: societe } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { companyId: societe } }).catch(() => {});
    const ids = Object.values(ordres);
    const tx = (await prisma.expenseOrder.findMany({ where: { id: { in: ids } }, select: { transactionId: true } })).map((o) => o.transactionId).filter((x): x is string => Boolean(x));
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.paymentPiece.deleteMany({ where: { requestId: dossierId } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: dossierId } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { entityType: "PAYMENT_REQUEST", entityId: dossierId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: dossierId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: tx } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: deptId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [comptableId, demandeurId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [comptableId, demandeurId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societe } }).catch(() => {});
  }, 60_000);

  it("DÉFAUT 1 : un ordre REFUSÉ n'est ni dans la file des Finances, ni dans ce qu'il reste à payer", async () => {
    const file = await chargerOrdresDesFinances({ companyId: societe });
    expect(file.some((o) => o.id === ordres.refuse)).toBe(false);
    expect(file.some((o) => o.id === ordres.autorise)).toBe(true);
    const t = await chargerTresorerie(comptableId, societe);
    expect(t.autorises.montant).toBe(50_000 + 10_000 + 20_000);
  });

  it("DÉFAUT 3 : la remise de caisse est reconnue par la file (pas de budget, espèces) — et l'écran ne lui demande pas de budget", async () => {
    const file = await chargerOrdresDesFinances({ companyId: societe });
    expect(file.find((o) => o.id === ordres.remise)?.pettyCashAllotment).not.toBeNull();
    expect(file.find((o) => o.id === ordres.autorise)?.pettyCashAllotment).toBeNull();
    const page = readFileSync("src/app/(app)/finances/paiements-a-faire/page.tsx", "utf8");
    expect(page).toMatch(/needsBudget: !remise && needsBudgetChoice\(/);
  });

  it("le règlement écrit la date, le mode et la référence ; une date future est refusée", async () => {
    ACTOR = comptable;
    const futur = await settleExpenseOrder(fd({ id: ordres.regle, date: "2999-01-01" }));
    expect(futur.ok).toBe(false);
    expect(futur.error).toMatch(/futur/);
    const r = await settleExpenseOrder(fd({ id: ordres.regle, date: "2026-11-20", mode: "CHEQUE", reference: "CHQ-0042", budgetCategoryId: catId }));
    expect(r.ok, r.error).toBe(true);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordres.regle } });
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: o.transactionId! } });
    expect(o.status).toBe("PAID");
    expect(o.paidDate?.toISOString()).toBe("2026-11-20T12:00:00.000Z");
    expect(t.date.toISOString()).toBe("2026-11-20T12:00:00.000Z");
    expect(t.method).toBe("CHEQUE");
    expect(t.notes).toBe("Référence du paiement : CHQ-0042");
  });

  it("DÉFAUT 3 (serveur) : la remise se paie sans budget, en espèces, à la date et sous la référence saisies", async () => {
    ACTOR = comptable;
    const r = await settleExpenseOrder(fd({ id: ordres.remise, date: "2026-11-21", reference: "BON-7" }));
    expect(r.ok, r.error).toBe(true);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordres.remise } });
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: o.transactionId! } });
    expect(t.method).toBe("CASH");
    expect(t.budgetCategoryId).toBeNull();
    expect(t.date.toISOString()).toBe("2026-11-21T12:00:00.000Z");
    expect(t.notes).toBe("Référence du paiement : BON-7");
  });

  it("« ACTUALISER LES SOLDES » par les Finances : la saisie s'ouvre (demande à leur nom, sans sonnerie), et se réutilise", async () => {
    ACTOR = demandeur;
    expect((await ouvrirActualisationSoldes(fd({ entite: societe }))).ok).toBe(false);
    ACTOR = comptable;
    expect((await ouvrirActualisationSoldes(fd({ entite: societe }))).error).toMatch(/Aucun compte/);
    await prisma.treasuryAccount.create({ data: { name: `${TAG} BNA`, companyId: societe, openingBalance: 1_000_000, openingDate: new Date("2026-11-20T12:00:00Z") } });
    const r1 = await ouvrirActualisationSoldes(fd({ entite: societe }));
    expect(r1.ok, r1.error).toBe(true);
    const d = await prisma.demandeActualisationSoldes.findUniqueOrThrow({ where: { id: r1.id! }, include: { lignes: true } });
    expect(d.demandeParId).toBe(comptableId);
    expect(d.lignes).toHaveLength(1);
    expect((await ouvrirActualisationSoldes(fd({ entite: societe }))).id).toBe(r1.id);
  });

  it("LA QUESTION : notification + ligne « Aujourd'hui » du demandeur, état « en attente » sur la ligne des Finances", async () => {
    ACTOR = comptable;
    const r = await poserQuestionAuDemandeur(fd({
      orderId: ordres.autorise, message: "Merci de transmettre le RIB du fournisseur.",
      file: new File([new Uint8Array([7, 8, 9])], `${TAG}-modele.pdf`, { type: "application/pdf" }),
    }));
    expect(r.ok, r.error).toBe(true);
    const notif = await prisma.notification.findFirst({ where: { userId: demandeurId, title: "Les Finances vous posent une question" } });
    expect(notif?.link).toBe(`/validations/paiements/${dossierId}#question-finances`);
    // La pièce des Finances est une pièce du dossier.
    expect(await prisma.paymentPiece.count({ where: { requestId: dossierId } })).toBe(1);

    const lignes = await lignesQuestionsDesFinances(demandeur);
    expect(lignes).toHaveLength(1);
    expect(lignes[0].title).toBe(`Les Finances vous posent une question — ${TAG} stand`);
    expect(natureDe({ ...lignes[0], famille: null, montant: null, statut: null } as Parameters<typeof natureDe>[0])).toBe("question-finances");

    const vue = (await chargerDossiersDesLignes([{ id: ordres.autorise, beneficiary: `${TAG} Fournisseur` }])).get(ordres.autorise)!;
    expect(vue.question).toBe("EN_ATTENTE_DEMANDEUR");
    expect(vue.fil.map((m) => m.genre)).toContain("Question des Finances");
    expect(vue.justificatif?.nom).toBe(`${TAG}-modele.pdf`);
    // Un rappel manuel dans la foulée : trop tôt.
    expect((await relancerQuestionDemandeur(fd({ orderId: ordres.autorise }))).error).toMatch(/24 heures/);
  });

  it("LE DEMANDEUR SEUL répond ; sa pièce entre au DOSSIER ; les Finances sont prévenues ; « Réponse reçue » puis lue", async () => {
    ACTOR = comptable;
    expect((await repondreAuxFinances(fd({ requestId: dossierId, message: "je réponds à sa place" }))).ok).toBe(false);
    ACTOR = demandeur;
    const piece = await addPaymentPiece(fd({ requestId: dossierId, kind: "OTHER", file: new File([new Uint8Array([1, 2, 3, 4])], `${TAG}-rib.pdf`, { type: "application/pdf" }) }));
    expect(piece.ok, piece.error).toBe(true);
    const r = await repondreAuxFinances(fd({ requestId: dossierId, message: "Le fournisseur préfère un chèque.", pieceId: piece.id! }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.paymentPiece.count({ where: { requestId: dossierId } })).toBe(2);
    const notif = await prisma.notification.findFirst({ where: { userId: comptableId, title: "Réponse du demandeur à votre question" } });
    expect(notif?.link).toBe(`/finances/paiements-a-faire?focus=${ordres.autorise}#ord-${ordres.autorise}`);
    expect(await lignesQuestionsDesFinances(demandeur)).toHaveLength(0);

    let vue = (await chargerDossiersDesLignes([{ id: ordres.autorise, beneficiary: null }])).get(ordres.autorise)!;
    expect(vue.question).toBe("REPONSE_RECUE");
    expect(vue.fil.some((m) => m.genre === "Réponse" && m.message?.includes(`${TAG}-rib.pdf`))).toBe(true);
    ACTOR = comptable;
    expect((await marquerReponseLue(fd({ orderId: ordres.autorise }))).ok).toBe(true);
    vue = (await chargerDossiersDesLignes([{ id: ordres.autorise, beneficiary: null }])).get(ordres.autorise)!;
    expect(vue.question).toBeNull();
  });

  it("un message libre du demandeur répond aussi, et prévient les Finances", async () => {
    ACTOR = comptable;
    await poserQuestionAuDemandeur(fd({ orderId: ordres.autorise, message: "Un acompte de 50 % convient-il ?" }));
    ACTOR = demandeur;
    const avant = await prisma.notification.count({ where: { userId: comptableId, title: "Réponse du demandeur à votre question" } });
    expect((await addPaymentComment(fd({ requestId: dossierId, message: "Oui, 50 % maintenant." }))).ok).toBe(true);
    expect(await prisma.notification.count({ where: { userId: comptableId, title: "Réponse du demandeur à votre question" } })).toBe(avant + 1);
  });

  it("RAPPEL AUTOMATIQUE après N jours, idempotent ; les relances du demandeur se lisent sur la ligne", async () => {
    ACTOR = comptable;
    await poserQuestionAuDemandeur(fd({ orderId: ordres.autorise, message: "Mode de règlement souhaité ?" }));
    const dans4j = new Date(Date.now() + 4 * 86_400_000);
    const n1 = await rappelerQuestionsSansReponse(dans4j);
    const n2 = await rappelerQuestionsSansReponse(dans4j);
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBe(0);
    expect(await prisma.paymentRequestEvent.count({ where: { requestId: dossierId, kind: "RAPPEL_QUESTION" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: demandeurId, title: "Rappel — les Finances attendent votre réponse" } })).toBe(1);

    await prisma.paymentRequestEvent.createMany({ data: [
      { requestId: dossierId, actorId: demandeurId, kind: "NUDGE", message: "Relance", at: new Date("2026-11-20T09:00:00Z") },
      { requestId: dossierId, actorId: demandeurId, kind: "NUDGE", message: "Relance", at: new Date("2026-11-23T09:00:00Z") },
    ] });
    const vue = (await chargerDossiersDesLignes([{ id: ordres.autorise, beneficiary: null }])).get(ordres.autorise)!;
    expect(vue.relances).toBe("Relancé 2 fois par le demandeur — dernière relance le 23/11/2026");
  });
});
