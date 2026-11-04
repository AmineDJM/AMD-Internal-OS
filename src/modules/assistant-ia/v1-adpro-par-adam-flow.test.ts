import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT V1 — LE SPONSORING DE BOUT EN BOUT PAR ADAM (Direction, 03/11/2026).
 *
 * Les MÊMES gestes que le banc d'écran (`e2e/v1-adpro-sponsoring.spec.ts`), demandés à l'assistant : chaque
 * acteur appelle l'outil que le modèle appellerait (opération `preparer_sponsoring`, puis le chemin générique des
 * capacités), une CARTE se prépare sans rien écrire, la personne la confirme, et c'est l'action de l'écran qui
 * s'exécute sous sa session. Aucun modèle n'est appelé (déterministe), aucune sortie (pas de mail, pas de push).
 *
 *   délégué : prépare la demande → NS, Directeur des opérations, Direction Marketing : approuvent (circuit) →
 *   délégué : soumet le poste → Direction Marketing : l'accorde (montant + budget, carte renforcée) →
 *   PDG : autorise l'ordre au centre de paiement → Finances : règlent (à l'écran : Adam refuse tant que la famille
 *   « Salaires & paie » est fermée) → le budget est consommé au centime.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({
  ...(await original<typeof import("@/lib/session")>()),
  requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUserPourEcrire: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { SPONSORING_CREATION } from "./infra/operations/adpro-sponsoring";
import { executerOperationIA } from "./infra/operations";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { demanderPaiementPoste } from "@/modules/ad-pro/actions-postes-paiement";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";
import { annulerGeste } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__v1adam_${Date.now().toString(36)}_`;
const INSTITUTION = `${TAG}Société de pneumologie`;
const MEDECIN = `${TAG}Dr Nadia Pneumo`;
type Qui = "kam" | "ns" | "ops" | "dm" | "pdg" | "fin";
const ROLES: Record<Qui, CurrentUser["role"]> = {
  kam: "MEDICAL_DELEGATE", ns: "NATIONAL_SALES", ops: "OPERATIONS_DIRECTOR", dm: "PRODUCT_MANAGER", pdg: "DIRECTION", fin: "FINANCE_BUDGET_MANAGER",
};
const u = {} as Record<Qui, CurrentUser>;
let spo = "", categorie = "", compte = "", demandePdf = "", ordreRegle = "";

async function creerCompte(qui: Qui): Promise<CurrentUser> {
  const c = await prisma.user.create({ data: { name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, passwordHash: "x", role: ROLES[qui] } });
  // L'assistant est ouvert à la personne (module ASSISTANT_IA) — sans lui, aucun outil.
  await prisma.userAccess.create({ data: { userId: c.id, module: "ASSISTANT_IA", canView: true, canCreate: true, canUpdate: true, scope: "ASSIGNED" } }).catch(() => {});
  const access = await getAccess(c.id, c.role);
  return { id: c.id, name: c.name, email: c.email, role: access.role ?? c.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/** Le geste demandé à Adam : l'outil prépare une carte, la personne la confirme (avec la ressaisie si la carte l'exige). */
async function parAdam(qui: Qui, outilNom: string, entree: Record<string, unknown>) {
  const user = u[qui];
  ACTEUR = user;
  const props: PropositionPreparee[] = [];
  const outil = outilsV1(user, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === outilNom);
  if (!outil) throw new Error(`l'outil ${outilNom} n'est pas offert au rôle ${user.role}`);
  const sortie = JSON.parse(await outil.run(entree, user));
  expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
  expect(props).toHaveLength(1);
  const p = props[0]!;
  const r = await confirmerIntentionAssistantIA(p.intentId, p.proposition.confirmText ?? undefined);
  expect(r.ok, r.error).toBe(true);
  return r;
}

suite("Lot V1 — le sponsoring de bout en bout par Adam", () => {
  beforeAll(async () => {
    // Par VAGUES (décor court : `platform/decors-de-test.test.ts`) — rien ne lie les comptes, l'enveloppe, le compte.
    const qui = Object.keys(ROLES) as Qui[];
    const [comptes, , env, banque, blob] = await Promise.all([
      Promise.all(qui.map(creerCompte)),
      prisma.medicalDoctor.create({ data: { name: MEDECIN, specialty: "Pneumologie", wilaya: "Alger" } }),
      prisma.budgetEnvelope.create({
        data: { name: `${TAG}Enveloppe`, modules: ["SPONSORING"], domaine: "MARKETING", totalAmount: 5_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") } as never,
      }),
      prisma.treasuryAccount.create({ data: { name: `${TAG}Banque`, openingBalance: 3_000_000, principal: true } }),
      putBlob(Buffer.from(`%PDF-1.4 ${TAG} demande`)),
    ]);
    qui.forEach((q, i) => { u[q] = comptes[i]!; });
    compte = banque.id;
    const [cat, fichier] = await Promise.all([
      prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Sponsoring`, allocated: 2_000_000 } }),
      enregistrerFichierDrive(u.kam, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId: blob.blobId, size: blob.size, mimeType: "application/pdf", name: `${TAG}demande.pdf` }),
    ]);
    categorie = cat.id;
    demandePdf = fichier.id;
  }, 90_000);

  afterAll(async () => {
    const ids = Object.values(u).map((x) => x.id);
    const postes = (await prisma.adProItem.findMany({ where: { sponsoringId: spo || "-" }, select: { id: true, expenseOrderId: true } }));
    const ordres = postes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x));
    const ecritures = (await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { transactionId: true } })).map((o) => o.transactionId).filter((x): x is string => Boolean(x));
    await prisma.expenseOrder.updateMany({ where: { id: { in: ordres } }, data: { transactionId: null } }).catch(() => {});
    await prisma.financeTransaction.updateMany({ where: { treasuryAccountId: compte || "-" }, data: { compensationDeId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ id: { in: ecritures } }, { budgetCategoryId: categorie || "-" }, { treasuryAccountId: compte || "-" }] } }).catch(() => {});
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { expenseOrderId: { in: ordres } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { sponsoringId: spo || "-" }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes.map((p) => p.id) } }, select: { legalDocumentId: true } }).catch(() => []);
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes.map((p) => p.id) } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { entityId: { in: [spo, ...postes.map((p) => p.id), ...liens.map((l) => l.legalDocumentId)].filter(Boolean) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: liens.map((l) => l.legalDocumentId) } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes.map((p) => p.id) } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spo || "-" } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: spo || "-" } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: spo || "-" } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: spo || "-" } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { institution: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { name: { startsWith: TAG } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 90_000);

  it("1 · le délégué demande à Adam : la carte récapitule, la confirmation crée la demande, son poste et la pièce", async () => {
    ACTEUR = u.kam;
    const p = await SPONSORING_CREATION.proposer({
      institution: INSTITUTION, medecins: MEDECIN, produits: "Pneumolex", ville: "Alger", specialite: "Pneumologie", type: "Congrès", nature: "direct",
      montantDemande: 420_000.4, montantSuggere: 400_000.3, importance: "haute", demandeMedecin: demandePdf,
    }, u.kam);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(await prisma.sponsoringRequest.count({ where: { institution: INSTITUTION } }), "rien n'est écrit avant la confirmation").toBe(0);
    const r = await executerOperationIA(u.kam, { kind: "assistant_ia_op", op: SPONSORING_CREATION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const s = await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: INSTITUTION }, include: { items: true } });
    spo = s.id;
    expect(Number(s.amountProposed)).toBe(400_000.3);
    expect(s.items).toHaveLength(1);
    expect(Number(s.items[0]!.amountEstimated)).toBe(400_000.3);
    expect(await prisma.document.count({ where: { entityType: "SPONSORING", entityId: spo } })).toBeGreaterThan(0);
  }, 60_000);

  it("2 · le circuit par Adam : National Sales, Directeur des opérations, Direction Marketing approuvent → pré-validée", async () => {
    for (const q of ["ns", "ops", "dm"] as const) {
      await parAdam(q, "workflow__advanceWorkflow", { entityType: "SPONSORING", entityId: spo, action: "APPROVE", note: `Avis ${q} (Adam)` });
    }
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo } })).status).toBe("PRE_VALIDATED");
    const evts = await prisma.workflowStepEvent.findMany({ where: { instance: { entityId: spo }, action: "APPROVE" }, select: { stepSlug: true, actorId: true } });
    expect(evts.map((e) => e.stepSlug).sort()).toEqual(["final", "marketing", "preliminary"]);
    expect(evts.find((e) => e.stepSlug === "final")!.actorId, "chaque geste au nom de qui l'a confirmé").toBe(u.ops.id);
  }, 90_000);

  it("3 · le poste par Adam : le délégué le soumet, la Direction Marketing l'accorde (carte renforcée : le montant se ressaisit)", async () => {
    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spo } });
    await parAdam("kam", "ad-pro-item__submitAdProItem", { id: poste.id });
    await parAdam("dm", "ad-pro-item__decideAdProItem", { id: poste.id, decision: "APPROVED", amountGranted: 380_000.35, budgetCategoryId: categorie });
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: poste.id } });
    expect(p.status).toBe("APPROVED");
    expect(Number(p.amountGranted)).toBe(380_000.35);
    expect(p.budgetCategoryId).toBe(categorie);
  }, 60_000);

  it("4 · le paiement : demandé (pro forma jointe à l'écran), autorisé au centre par Adam, réglé — consommé au centime", async () => {
    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spo } });
    // Le dépôt d'une pièce reste un geste d'écran (le fichier vient de la personne) : la même action.
    ACTEUR = u.kam;
    const f = new FormData();
    f.set("id", poste.id); f.set("montant", "380000.35");
    f.append("attachment", new File([Buffer.from(`%PDF-1.4 ${TAG} proforma ${Date.now()}`)], "proforma.pdf", { type: "application/pdf" }));
    const d = await demanderPaiementPoste(undefined, f);
    expect(d.ok, d.error).toBe(true);
    const ordreId = (await prisma.adProItem.findUniqueOrThrow({ where: { id: poste.id } })).expenseOrderId!;
    expect(ordreId).toBeTruthy();

    await parAdam("pdg", "payment-centre__decidePayment", { id: ordreId, decision: "APPROVE", body: "Autorisé (Adam).", montantVu: 380_000.35 });
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).centralStatus).toBe("APPROVED");
    // LE RÈGLEMENT PAR ADAM est derrière la famille « Salaires & paie » (le même geste règle une paie) : fermée par
    // défaut, le refus le DIT et nomme qui l'ouvre. Constaté au lot V1 ; le geste se fait alors à l'écran (même action).
    ACTEUR = u.fin;
    const propsFin: PropositionPreparee[] = [];
    const outilFin = outilsV1(u.fin, propsFin, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === "expense__settleExpenseOrder")!;
    const refus = JSON.parse(await outilFin.run({ id: ordreId, treasuryAccountId: compte }, u.fin));
    expect(refus.statut).toBe("REFUS");
    expect(refus.raison).toMatch(/Salaires & paie/);
    const fs = new FormData(); fs.set("id", ordreId); fs.set("treasuryAccountId", compte);
    const regle = await settleExpenseOrder(fs);
    expect(regle.ok, regle.error).toBe(true);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } });
    expect(o.status).toBe("PAID");
    ordreRegle = ordreId;
    const somme = await prisma.financeTransaction.aggregate({ where: { budgetCategoryId: categorie, direction: "OUT", status: "SETTLED" }, _sum: { amount: true } });
    expect(Math.round(Number(somme._sum.amount) * 100), "consommé de la catégorie : 38 000 035 centimes").toBe(38_000_035);
  }, 90_000);

  it("5 · BACKUP (K10) : les Finances ANNULENT le règlement — l'ordre redevient à payer, la sortie se compense ; puis le RÉTABLISSENT", async () => {
    ACTEUR = u.fin;
    const consomme = async () => Math.round(Number((await prisma.financeTransaction.aggregate({ where: { budgetCategoryId: categorie, direction: "OUT", status: "SETTLED" }, _sum: { amount: true } }))._sum.amount ?? 0) * 100);
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: u.fin.id, capaciteId: "expense-actions:settleExpenseOrder", annuleLe: null }, orderBy: { creeLe: "desc" } });
    const r = await annulerGeste(g.id, u.fin);
    if ("refus" in r) throw new Error(r.refus);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreRegle } });
    expect(o.status, "le règlement annulé : l'ordre redevient à payer").toBe("PENDING");
    // L'écriture d'une sortie d'argent ne s'efface jamais : un « à récupérer » (IN, en attente) la compense.
    const aRecuperer = await prisma.financeTransaction.findMany({ where: { compensationDeId: { not: null }, direction: "IN", treasuryAccountId: compte } });
    expect(aRecuperer.length).toBeGreaterThan(0);
    expect(Math.round(Number(aRecuperer[0]!.amount) * 100)).toBe(38_000_035);
    const retabli = await retablirGeste(r.gesteId, u.fin);
    if ("refus" in retabli) throw new Error(retabli.refus);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreRegle } })).status, "rétabli : de nouveau payé").toBe("PAID");
    expect(await consomme()).toBeGreaterThanOrEqual(38_000_035);
  }, 90_000);
});
