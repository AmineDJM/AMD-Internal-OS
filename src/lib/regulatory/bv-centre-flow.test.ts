import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestBV, setRegulatoryStepState } from "@/lib/actions/regulatory-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { getPendingValidations } from "@/lib/queries/validations";
import { getBudgetOverview } from "@/lib/queries/budget";
import { vueBvParDossier } from "@/lib/queries/budget-regulatory";
import { budgetBvDuDossier } from "@/lib/queries/budget-bv-acceptes";
import { createExpenseOrder } from "@/modules/finances/api";
import type { RegWorkflowState } from "@/lib/regulatory-workflow";
import { OBJET_BV_REGULATORY } from "./bv-validation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BV D'UN DOSSIER PAR LE CENTRE DE VALIDATIONS, DE LA DEMANDE AU BUDGET — par les VRAIS points d'entrée.
 *
 * Demande (montant + pièce) → refus (Refusé, motif, redemande possible) → redemande → acceptation par une personne qui a
 * l'accès au Centre de validations SANS rôle de direction (ouvert par la console après la demande) → paiement
 * déverrouillé → engagé exact au budget Regulatory → paiement « fait » → consommé exact, engagé diminué d'autant →
 * retour à « à faire » → réengagé. Double clic → une seule demande. Ancien ordre autorisé → paiement déverrouillé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__bvcentre${Date.now().toString(36)}__`;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(id, u.role), mustChangePassword: false } as unknown as CurrentUser;
}
const form = (fields: Record<string, string>, files: Record<string, File> = {}): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const [k, f] of Object.entries(files)) fd.append(k, f);
  return fd;
};
const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: "application/pdf" });

suite("BV d'un dossier — Centre de validations → budget Regulatory", () => {
  let raId = "", membreId = "", tiersId = "", tardId = "", societeId = "", produitId = "", ancienId = "", envId = "", c25 = "", c75 = "";
  const comptes = () => [raId, membreId, tiersId, tardId];

  const demandes = (nature: "25" | "75" = "25", productId = produitId) => prisma.validationRequest.findMany({
    where: { objectType: OBJET_BV_REGULATORY[nature], entityId: productId },
    include: { steps: true }, orderBy: { createdAt: "asc" },
  });
  const workflow = async (productId = produitId) =>
    (await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: productId }, select: { workflow: true } })).workflow as RegWorkflowState;
  const budget = async () => {
    const o = await getBudgetOverview((await actorFor(raId)) as unknown as SessionUser, envId);
    const c = o!.categories.find((x) => x.id === c25)!;
    return { engage: c.committed, consomme: c.consumed };
  };

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    raId = (await mk("ra", "SUPER_ADMIN")).id;
    membreId = (await mk("membre", "COORDINATOR")).id;
    tiersId = (await mk("tiers", "COORDINATOR")).id;
    tardId = (await mk("tard", "COORDINATOR")).id;
    // LE SUPER ADMIN OUVRE LE CENTRE DE VALIDATIONS depuis la console — à une personne qui n'a aucun rôle de direction.
    await prisma.userAccess.create({ data: { userId: membreId, module: "VALIDATION_CENTRE", canView: true } });
    societeId = (await prisma.company.create({ data: { name: `${TAG}Société` } })).id;
    const presub = { presub_ans: { status: "DONE", outcome: "FAVORABLE" } };
    produitId = (await prisma.regulatoryProduct.create({
      data: { dci: `${TAG}PARACETAMOL`, brandName: `${TAG}Doliprane`, reference: `${TAG}REG`, companyId: societeId, workflow: presub },
    })).id;
    ancienId = (await prisma.regulatoryProduct.create({
      data: { dci: `${TAG}IBUPROFENE`, reference: `${TAG}OLD`, companyId: societeId, workflow: presub },
    })).id;
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG}Budget Regulatory`, domaine: "REGULATORY", companyId: societeId, totalAmount: 5_000_000, isActive: true,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)), periodEnd: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 11, 31)),
        categories: { create: [{ name: "BV 25 %", cle: "BV_25", allocated: 1_000_000 }, { name: "BV 75 %", cle: "BV_75", allocated: 3_000_000 }] },
      },
      include: { categories: true },
    });
    envId = env.id;
    c25 = env.categories.find((c) => c.cle === "BV_25")!.id;
    c75 = env.categories.find((c) => c.cle === "BV_75")!.id;
  });

  afterAll(async () => {
    const produits = [produitId, ancienId];
    const vals = await prisma.validationRequest.findMany({ where: { entityId: { in: produits } }, select: { id: true } });
    await prisma.validationRequest.deleteMany({ where: { id: { in: vals.map((v) => v.id) } } }).catch(() => undefined);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: { in: produits } }, select: { id: true } });
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => undefined);
    const docs = await prisma.document.findMany({ where: { entityId: { in: produits } }, select: { id: true } });
    await retirerDocumentsEtContenu({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes() } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes() } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: { in: produits } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: comptes() } } }).catch(() => undefined);
  });

  it("demande (double clic) : UNE demande au centre, la pièce sur l'étape, l'étape « en cours », le membre saisi et prévenu", async () => {
    ACTOR = await actorFor(raId);
    const [a, b] = await Promise.all([
      requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "120000", note: "Échéance ANPP le 30" }, { files: pdf("proforma-bv.pdf") })),
      requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "120000" })),
    ]);
    expect([a.ok, b.ok].filter(Boolean), "un seul accepté pour deux clics").toHaveLength(1);
    expect([a, b].find((r) => !r.ok)?.error).toContain("déjà demandé");
    const [d] = await demandes();
    expect(await demandes()).toHaveLength(1);
    expect(d.status).toBe("PENDING");
    expect(Number(d.amount)).toBe(120000);
    expect(d.mode).toBe("PARALLEL");
    expect(d.link).toBe(`/regulatory/${produitId}`);
    const validateurs = d.steps.map((s) => s.validatorId);
    expect(validateurs).toContain(membreId);
    expect(validateurs, "le demandeur ne tranche pas sa propre demande").not.toContain(raId);
    expect(validateurs).not.toContain(tiersId);
    expect(await prisma.notification.count({ where: { userId: membreId, type: "VALIDATION_REQUIRED" } })).toBe(1);
    expect(await prisma.expenseOrder.count({ where: { sourceId: produitId } }), "plus d'ordre de dépense").toBe(0);
    const pieces = await prisma.document.findMany({ where: { entityType: "REGULATORY_PRODUCT", entityId: produitId, stepKey: "bv25_req" } });
    if (a.ok || b.ok) expect(pieces.length).toBeLessThanOrEqual(1);
    expect((await workflow()).bv25_req?.status).toBe("DOING");
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: produitId }, select: { status: true } });
    expect(p.status, "demandé mais pas accepté n'est pas « attente paiement BV »").not.toBe("AWAITING_BV_PAYMENT");

    const file = await getPendingValidations(membreId);
    expect(file.filter((v) => v.requestId === d.id)).toHaveLength(1);
    expect(await getPendingValidations(tiersId)).toHaveLength(0);
  });

  it("avant acceptation, le paiement est refusé côté serveur ; le budget n'engage rien", async () => {
    ACTOR = await actorFor(raId);
    const r = await setRegulatoryStepState(form({ productId: produitId, stepKey: "bv25_pay", status: "DONE" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verrouillé/);
    expect((await workflow()).bv25_pay?.status ?? "TODO").toBe("TODO");
    expect(await budget()).toEqual({ engage: 0, consomme: 0 });
  });

  it("refus (motif) : « Refusé », l'étape revient à faire, le demandeur prévenu vers la fiche ; un tiers sans accès ne tranche pas", async () => {
    const [d] = await demandes();
    const etape = d.steps.find((s) => s.validatorId === membreId)!;
    ACTOR = await actorFor(tiersId);
    const sansAcces = await decideValidation(form({ stepId: etape.id, decision: "APPROVED" }));
    expect(sansAcces.ok).toBe(false);
    expect(sansAcces.error).toMatch(/Centre de validations/);

    ACTOR = await actorFor(membreId);
    const r = await decideValidation(form({ stepId: etape.id, decision: "REJECTED", reason: "Montant à revoir" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const [apres] = await demandes();
    expect(apres.status).toBe("REJECTED");
    expect(apres.steps.filter((s) => s.status === "PENDING"), "une décision suffit").toHaveLength(0);
    expect((await workflow()).bv25_req?.status).toBe("TODO");
    const notif = await prisma.notification.findFirst({ where: { userId: raId, link: `/regulatory/${produitId}` }, orderBy: { createdAt: "desc" } });
    expect(notif?.body).toContain("Montant à revoir");
    expect(notif?.body).toMatch(/redemander/);
  });

  it("redemande, puis acceptation par une personne qui a reçu l'accès APRÈS la demande — sur sa propre étape", async () => {
    ACTOR = await actorFor(raId);
    const re = await requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "150000" }));
    expect(re.ok, re.ok ? "" : re.error).toBe(true);
    const nouvelle = (await demandes()).at(-1)!;
    expect(nouvelle.status).toBe("PENDING");
    expect(nouvelle.steps.map((s) => s.validatorId)).not.toContain(tardId);

    await prisma.userAccess.create({ data: { userId: tardId, module: "VALIDATION_CENTRE", canView: true } });
    const file = (await getPendingValidations(tardId)).filter((v) => v.requestId === nouvelle.id);
    expect(file, "la file du nouveau membre montre la demande, une fois").toHaveLength(1);
    expect(file[0].actionable).toBe(true);

    ACTOR = await actorFor(tardId);
    const ok = await decideValidation(form({ stepId: file[0].stepId, decision: "APPROVED" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const acceptee = await prisma.validationRequest.findUniqueOrThrow({ where: { id: nouvelle.id }, include: { steps: true } });
    expect(acceptee.status).toBe("APPROVED");
    expect(acceptee.steps.find((s) => s.validatorId === tardId)?.status, "la décision est à son nom").toBe("APPROVED");
    expect(acceptee.steps.filter((s) => s.status === "PENDING")).toHaveLength(0);
    expect((await workflow()).bv25_req?.status).toBe("DONE");
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: produitId }, select: { status: true } });
    expect(p.status).toBe("AWAITING_BV_PAYMENT");
    // Accepté : on ne redemande plus.
    ACTOR = await actorFor(raId);
    const encore = await requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "150000" }));
    expect(encore.ok).toBe(false);
  });

  it("budget : accepté → engagé exact ; payé → consommé exact, engagé diminué d'autant ; remis à faire → réengagé", async () => {
    expect(await budget()).toEqual({ engage: 150000, consomme: 0 });
    ACTOR = await actorFor(raId);
    const vue = await vueBvParDossier(ACTOR as unknown as SessionUser, (await getBudgetOverview(ACTOR as unknown as SessionUser, envId))!);
    const ligne = vue.lignes.find((l) => l.dossierId === produitId)!;
    expect(ligne.bv25.demande).toBe(150000);
    expect(ligne.prevision75, "la prévision 3 × BV 25 % est conservée").toBe(450000);
    expect(ligne.bv25.aImputer).toEqual([]);

    const paye = await setRegulatoryStepState(form({ productId: produitId, stepKey: "bv25_pay", status: "DONE" }));
    expect(paye.ok, paye.ok ? "" : paye.error).toBe(true);
    expect(await budget()).toEqual({ engage: 0, consomme: 150000 });
    const encadre = await budgetBvDuDossier({ id: produitId, status: "IN_PREPARATION" }, []);
    expect(encadre[0]).toMatchObject({ nature: "25", demande: 150000, engage: 0, consomme: 150000, circuit: "VALIDATION" });
    expect(encadre[0].enveloppe).toContain(`${TAG}Budget Regulatory`);
    expect(encadre[1].prevision).toBe(450000);

    const retour = await setRegulatoryStepState(form({ productId: produitId, stepKey: "bv25_pay", status: "TODO" }));
    expect(retour.ok).toBe(true);
    expect(await budget()).toEqual({ engage: 150000, consomme: 0 });
    const c = (await getBudgetOverview(ACTOR as unknown as SessionUser, envId))!.categories.find((x) => x.id === c75)!;
    expect(c.committed, "rien sur la ligne du 75 %").toBe(0);
  });

  it("ancien circuit : un ordre en cours empêche la nouvelle demande ; autorisé par le centre de paiement, il déverrouille le paiement", async () => {
    const ordre = await createExpenseOrder({
      label: `BV 75 % — ${TAG}OLD`, amount: 300000, category: "IMPOT", beneficiary: "ANPP",
      sourceType: "REGULATORY_PRODUCT", sourceId: ancienId, requestedById: raId,
    });
    ACTOR = await actorFor(raId);
    const bloque = await requestBV(form({ productId: ancienId, stepKey: "bv75_req", amount: "300000" }));
    expect(bloque.ok).toBe(false);
    expect(bloque.error).toContain(ordre.reference);
    expect((await setRegulatoryStepState(form({ productId: ancienId, stepKey: "bv75_pay", status: "DONE" }))).ok).toBe(false);

    await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { centralStatus: "APPROVED", centralDecidedAt: new Date() } });
    const ok = await setRegulatoryStepState(form({ productId: ancienId, stepKey: "bv75_pay", status: "DONE" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect((await demandes("75", ancienId)), "aucune demande au centre de validations").toHaveLength(0);
  });
});
