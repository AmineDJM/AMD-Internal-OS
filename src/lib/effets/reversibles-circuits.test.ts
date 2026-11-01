import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — LES CIRCUITS, RÉVERSIBLES : avances RH, décisions de validation, congrès, imputations, BV, relances.
 * Chaque action EXÉCUTÉE (la vraie, au clic de l'écran), puis ANNULÉE (le bouton « Annuler »), contre la base
 * locale : l'étape se rouvre, ce qui en est né (ordre de paiement, dossier compagnon, notification) est retiré ou
 * compensé, le journal et l'audit gardent l'annulation. Une CASCADE qui ne se défait pas (un ordre payé depuis)
 * refuse TOUT, avec la liste, et rien n'est écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { cancelAdvance, decideAdvance, requestAdvance } from "@/modules/rh/actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { finalDecision, updateGrantedBudget } from "@/modules/ad-pro/actions-congres";
import { imputerBv } from "@/lib/actions/budget-pole-actions";
import { classerDepensesNonClassees } from "@/lib/actions/natures-moyens-generaux-actions";
import { requestBV } from "@/lib/actions/regulatory-actions";
import { relancerPaiement } from "@/modules/finances/actions-relances";
import { CLE_BV_25 } from "@/lib/budget-regulatory/bv";
import { assurerNaturesMoyensGeneraux } from "@/lib/general-means/natures-store";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zk10ccirc${Date.now()}`;
let moi: CurrentUser;
let karim = "";
let employe = "";
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
const nonVide = <T,>(r: T): T => { expect((r as { ok?: boolean; error?: string }).error ?? "", JSON.stringify(r)).toBe(""); return r; };

/** Le geste que l'action vient d'inscrire — `annulable.gesteId` rendu à l'écran. */
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await annulerGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
const retablir = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await retablirGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
/**
 * COMPLET À L'INTÉRIEUR DE L'ERP : tout ce qui est en base est défait ou compensé ; seuls restent « impossibles » les
 * effets SORTIS (la notification poussée déjà affichée sur un appareil), dits tels quels — jamais un « annulé » de façade.
 */
const completEnBase = async (gesteId: string, c: CompteRenduAnnulation) => {
  const externes = new Set((await prisma.assistantEffet.findMany({ where: { gesteId, type: "EXTERNE" }, select: { id: true } })).map((e) => e.id));
  const internes = c.details.filter((d) => d.issue === "IMPOSSIBLE" && !externes.has(d.effetId));
  expect(internes, JSON.stringify(internes)).toEqual([]);
  for (const d of c.details.filter((x) => externes.has(x.effetId) && x.issue === "IMPOSSIBLE")) expect(d.aLaPlace ?? d.pourquoi).toBeTruthy();
};
/** L'annulation est au journal (qui, quand) et à l'audit. */
const traceeDe = async (gesteId: string) => {
  const g = await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteId } });
  expect(g.annuleParId).toBe(moi.id);
  expect(g.annuleLe).toBeTruthy();
  expect(await prisma.auditLog.count({ where: { entityId: gesteId, summary: { contains: "Annulation" } } })).toBe(1);
};
const ordresDe = (sourceId: string) => prisma.expenseOrder.findMany({ where: { sourceId } });
let seq = 0;
const nouvelOrdre = (data: Record<string, unknown>) => prisma.expenseOrder.create({ data: { reference: `${TAG}-OD-${++seq}`, label: "Ordre", amount: 1000, ...data } as never });

suite("K10c — circuits : exécuter, annuler (cascade comprise), rétablir", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Direction`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false } as unknown as CurrentUser;
    ACTOR = moi;
    karim = (await prisma.user.create({ data: { name: `${TAG} Karim`, email: `${TAG}k@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } })).id;
    employe = (await prisma.employee.create({ data: { fullName: `${TAG} Karim`, baseSalary: 1, userId: karim } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = [moi.id, karim];
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    const ordres = await prisma.expenseOrder.findMany({ where: { OR: [{ reference: { startsWith: TAG } }, { label: { contains: TAG } }, { requestedById: { in: ids } }] }, select: { id: true } });
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { label: { contains: TAG } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.salaryAdvance.deleteMany({ where: { employeeId: employe } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: employe } }).catch(() => undefined);
    await prisma.validationRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }, 60_000);

  it("demande d'avance : la demande créée est retirée ; rétablir la remet (même identifiant)", async () => {
    const r = nonVide(await requestAdvance(undefined, fd({ employeeId: employe, amount: "40000", reason: `${TAG} loyer` })));
    const id = (r as { id: string }).id;
    const g = gesteDe(r);
    const c = await annuler(g);
    await completEnBase(g, c);
    expect(await prisma.salaryAdvance.findUnique({ where: { id } })).toBeNull();
    await traceeDe(g);
    await retablir(g);
    expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  });

  it("décision d'avance (accord) : l'avance revient EN ATTENTE, l'ordre né de l'accord et son dossier compagnon sont retirés, la notification aussi", async () => {
    const adv = await prisma.salaryAdvance.create({ data: { employeeId: employe, amount: 30000 } });
    const g = gesteDe(nonVide(await decideAdvance(fd({ id: adv.id, decision: "APPROVED" }))));
    const [ordre] = await ordresDe(adv.id);
    expect(ordre).toBeTruthy();
    expect(await prisma.notification.count({ where: { userId: karim, title: "Avance approuvée" } })).toBe(1);
    const c = await annuler(g);
    await completEnBase(g, c);
    const lue = await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: adv.id } });
    expect(lue.status).toBe("PENDING");
    expect(lue.decidedById).toBeNull();
    expect(await ordresDe(adv.id)).toHaveLength(0);
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: ordre!.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: karim, title: "Avance approuvée" } })).toBe(0);
    await traceeDe(g);
    // L'étape rouverte se tranche de nouveau.
    nonVide(await decideAdvance(fd({ id: adv.id, decision: "REJECTED", note: "budget" })));
    expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: adv.id } })).status).toBe("REJECTED");
  });

  it("CASCADE : l'ordre né de l'accord a été PAYÉ depuis — l'annulation refuse tout, avec la liste, et rien n'est écrit", async () => {
    const adv = await prisma.salaryAdvance.create({ data: { employeeId: employe, amount: 25000 } });
    const g = gesteDe(nonVide(await decideAdvance(fd({ id: adv.id, decision: "APPROVED" }))));
    const [ordre] = await ordresDe(adv.id);
    await prisma.expenseOrder.update({ where: { id: ordre!.id }, data: { status: "PAID" } });
    const r = await annulerGeste(g, moi);
    expect("refus" in r ? r.refus : "").toMatch(/Rien n'a été annulé/);
    const bloquants = "refus" in r ? r.bloquants ?? [] : [];
    expect(bloquants.length).toBeGreaterThan(0);
    expect(bloquants.some((b) => /ordre|dépense|paiement/i.test(`${b.quoi} ${b.pourquoi}`))).toBe(true);
    expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: adv.id } })).status).toBe("APPROVED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre!.id } })).status).toBe("PAID");
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g } })).annuleLe).toBeNull();
  });

  it("annulation d'une avance par les RH : elle revient en attente ; la notification déjà LUE reçoit un rectificatif", async () => {
    const adv = await prisma.salaryAdvance.create({ data: { employeeId: employe, amount: 20000 } });
    const g = gesteDe(nonVide(await cancelAdvance(fd({ id: adv.id }))));
    expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: adv.id } })).status).toBe("CANCELLED");
    await prisma.notification.updateMany({ where: { userId: karim, title: "Avance sur salaire annulée" }, data: { isRead: true } });
    const c = await annuler(g);
    await completEnBase(g, c);
    expect(c.details.some((d) => d.issue === "COMPENSE" && /rectificatif/.test(d.pourquoi))).toBe(true);
    expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: adv.id } })).status).toBe("PENDING");
    expect(await prisma.notification.count({ where: { userId: karim, title: { startsWith: "Rectificatif" } } })).toBe(1);
    await traceeDe(g);
  });

  it("décision de validation : l'étape est rouverte, la demande revient EN ATTENTE, la notification du demandeur retirée ; rétablir", async () => {
    const req = await prisma.validationRequest.create({
      data: { reference: `${TAG}-VAL-1`, module: "GENERIC", title: `${TAG} achat`, requesterId: karim, steps: { create: [{ order: 1, validatorId: moi.id }] } },
      include: { steps: true },
    });
    const step = req.steps[0]!;
    const g = gesteDe(nonVide(await decideValidation(fd({ stepId: step.id, decision: "APPROVED" }))));
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
    const notifs = await prisma.notification.count({ where: { userId: karim, createdAt: { gte: req.createdAt } } });
    expect(notifs).toBeGreaterThan(0);
    const c = await annuler(g);
    await completEnBase(g, c);
    const relue = await prisma.validationRequest.findUniqueOrThrow({ where: { id: req.id }, include: { steps: true } });
    expect(relue.status).toBe("PENDING");
    expect(relue.decidedAt).toBeNull();
    expect(relue.steps[0]!.status).toBe("PENDING");
    expect(relue.steps[0]!.decidedAt).toBeNull();
    expect(await prisma.notification.count({ where: { userId: karim, createdAt: { gte: req.createdAt } } })).toBe(0);
    await traceeDe(g);
    await retablir(g);
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
  });

  it("décision de validation, notification LUE par le demandeur : rectificatif, et l'étape rouverte quand même", async () => {
    const req = await prisma.validationRequest.create({
      data: { reference: `${TAG}-VAL-2`, module: "GENERIC", title: `${TAG} mission`, requesterId: karim, steps: { create: [{ order: 1, validatorId: moi.id }] } },
      include: { steps: true },
    });
    const g = gesteDe(nonVide(await decideValidation(fd({ stepId: req.steps[0]!.id, decision: "REJECTED", reason: "hors budget" }))));
    await prisma.notification.updateMany({ where: { userId: karim, createdAt: { gte: req.createdAt } }, data: { isRead: true } });
    const c = await annuler(g);
    expect(c.details.some((d) => d.issue === "COMPENSE" && /rectificatif/.test(d.pourquoi))).toBe(true);
    expect((await prisma.validationStep.findUniqueOrThrow({ where: { id: req.steps[0]!.id } })).status).toBe("PENDING");
    expect(await prisma.notification.count({ where: { userId: karim, title: { startsWith: "Rectificatif" }, createdAt: { gte: req.createdAt } } })).toBe(1);
  });

  it("décision finale d'un congrès : la demande revient en attente de décision, ce qui est né de l'accord (ordre, déclaration) est retiré", async () => {
    const c0 = await prisma.congressNational.create({ data: { name: `${TAG} Journées`, requesterId: karim, requestStatus: "AWAITING_FINAL" } });
    const g = gesteDe(nonVide(await finalDecision(fd({ type: "NATIONAL", id: c0.id, decision: "APPROVE", finalAmount: "500000" }))));
    const apres = await prisma.congressNational.findUniqueOrThrow({ where: { id: c0.id } });
    expect(apres.requestStatus).toBe("APPROVED");
    const nes = (await ordresDe(c0.id)).length + await prisma.medicalInfoDeclaration.count({ where: { sourceId: c0.id } });
    expect(nes).toBeGreaterThan(0);
    const c = await annuler(g);
    await completEnBase(g, c);
    const relu = await prisma.congressNational.findUniqueOrThrow({ where: { id: c0.id } });
    expect(relu.requestStatus).toBe("AWAITING_FINAL");
    expect(relu.finalAmount).toBeNull();
    expect(relu.finalById).toBeNull();
    expect(await ordresDe(c0.id)).toHaveLength(0);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: c0.id } })).toBe(0);
    await traceeDe(g);
  });

  it("montant accordé d'un congrès : le montant d'avant revient, sur le congrès ET sur l'ordre non réglé", async () => {
    const c0 = await prisma.congressNational.create({ data: { name: `${TAG} Symposium`, requesterId: karim, requestStatus: "APPROVED", finalAmount: 300000 } });
    const ordre = await nouvelOrdre({ label: `${TAG} Symposium`, amount: 300000, sourceType: "CONGRESS_NATIONAL", sourceId: c0.id, requestedById: karim, centralStatus: "AWAITING" });
    await prisma.congressNational.update({ where: { id: c0.id }, data: { expenseOrderId: ordre.id } });
    const g = gesteDe(nonVide(await updateGrantedBudget(fd({ type: "NATIONAL", id: c0.id, finalAmount: "250000" }))));
    expect(Number((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } })).amount)).toBe(250000);
    const c = await annuler(g);
    await completEnBase(g, c);
    expect(Number((await prisma.congressNational.findUniqueOrThrow({ where: { id: c0.id } })).finalAmount)).toBe(300000);
    expect(Number((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } })).amount)).toBe(300000);
    await traceeDe(g);
  });

  it("imputation d'un BV sur une enveloppe : l'ordre retrouve sa catégorie d'avant (aucune)", async () => {
    const env = await prisma.budgetEnvelope.create({ data: { name: `${TAG} BV`, domaine: "REGULATORY", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1_000_000 } as never });
    await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: "BV 25 %", cle: CLE_BV_25 } as never });
    const ordre = await nouvelOrdre({ label: `BV 25 % — ${TAG}`, sourceType: "REGULATORY_PRODUCT", sourceId: `${TAG}-prod` });
    const g = gesteDe(nonVide(await imputerBv(fd({ envelopeId: env.id, orderId: ordre.id }))));
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } })).budgetCategoryId).toBeTruthy();
    const c = await annuler(g);
    await completEnBase(g, c);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } })).budgetCategoryId).toBeNull();
    await traceeDe(g);
  });

  it("classement des dépenses non classées : chaque dépense retrouve « non classée », les natures créées partent si rien ne s'y rattache", async () => {
    // Les natures d'office existent déjà en production (créées au premier passage) : le classement ne fait que ranger.
    await assurerNaturesMoyensGeneraux();
    const dep = await prisma.department.create({ data: { name: `${TAG} Moyens`, code: `${TAG}MG` } });
    const d1 = await prisma.departmentBudgetExpense.create({ data: { departmentId: dep.id, year: 2026, label: "Carburant véhicule de service", amount: 5000 } });
    const d2 = await prisma.departmentBudgetExpense.create({ data: { departmentId: dep.id, year: 2026, label: "Ramettes de papier et fournitures de bureau", amount: 3000 } });
    const r = nonVide(await classerDepensesNonClassees(fd({ departmentId: dep.id })));
    const g = gesteDe(r);
    const ranges = await prisma.departmentBudgetExpense.count({ where: { id: { in: [d1.id, d2.id] }, budgetCategoryId: { not: null } } });
    expect(ranges, (r as { message?: string }).message).toBeGreaterThan(0);
    const c = await annuler(g);
    await completEnBase(g, c);
    expect(await prisma.departmentBudgetExpense.count({ where: { id: { in: [d1.id, d2.id] }, budgetCategoryId: { not: null } } })).toBe(0);
    await traceeDe(g);
  });

  it("demande de BV : l'ordre, son dossier compagnon et l'étape du processus sont défaits", async () => {
    const soc = await prisma.company.create({ data: { name: `${TAG} Société` } });
    const p = await prisma.regulatoryProduct.create({ data: { dci: `${TAG}dci`, brandName: `${TAG}Marque`, reference: `${TAG}REF`, companyId: soc.id } });
    const g = gesteDe(nonVide(await requestBV(fd({ productId: p.id, amount: "120000", stepKey: "bv25_req" }))));
    const [ordre] = await ordresDe(p.id);
    expect(ordre).toBeTruthy();
    const c = await annuler(g);
    await completEnBase(g, c);
    expect(await ordresDe(p.id)).toHaveLength(0);
    const wf = (await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: p.id } })).workflow as Record<string, { status?: string }> | null;
    expect(wf?.bv25_req?.status ?? null).not.toBe("DONE");
    await traceeDe(g);
    await prisma.regulatoryProduct.delete({ where: { id: p.id } });
    await prisma.company.delete({ where: { id: soc.id } }).catch(() => undefined);
  });

  it("relance d'un paiement : le message de relance est retiré du fil du centre, les notifications non lues aussi", async () => {
    const ordre = await nouvelOrdre({ label: `${TAG} relance`, requestedById: moi.id, centralStatus: "AWAITING" });
    const g = gesteDe(nonVide(await relancerPaiement(fd({ cibleType: "EXPENSE_ORDER", cibleId: ordre.id }))));
    expect(await prisma.paymentCentreMessage.count({ where: { orderId: ordre.id } })).toBe(1);
    const c = await annuler(g);
    await completEnBase(g, c);
    expect(await prisma.paymentCentreMessage.count({ where: { orderId: ordre.id } })).toBe(0);
    await traceeDe(g);
  });
});
