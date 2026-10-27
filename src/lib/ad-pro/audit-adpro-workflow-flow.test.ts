import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/** Le seuil du DG est INJECTÉ dans ce processus : le banc ne dépend pas de la valeur du jour en base (§118.132). */
const SEUIL_DG = 1_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), adProDgThreshold: SEUIL_DG }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { sendLegalInvoiceToSettlement } from "@/lib/actions/legal-actions";
import { consommerDepensePoste, imputerDepensePoste } from "@/lib/actions/budget-depense-poste-actions";
import { addAdProItem, submitAdProItem, decideAdProItem } from "@/lib/actions/ad-pro-item-actions";
import { validateDeclarationByDirection } from "@/lib/actions/medical-info-actions";
import { statuerSurLeTotal } from "@/lib/ad-pro/porte-dg";
import { ensureInstance } from "@/lib/workflow/engine";
import { performAction } from "@/lib/assistant";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__auditadpro__";
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUDIT DU 27/10/2026 — Ad & Pro et moteur de workflow : les règles tenues sur TOUS les chemins.
 *
 * Chaque cas reproduit un chemin réel qui contournait le circuit du 27/10 (porte du DG sur le total,
 * « plus d'ordre global », création par le circuit, transfert sans argent engagé) et vérifie que le
 * serveur le refuse désormais. Les juges comptent par LIEN CAUSAL (l'ordre qui vise CETTE pièce, CETTE
 * demande), jamais par un compte global de la base partagée (§118.92).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Audit Ad & Pro — les règles du circuit tenues hors de l'écran du poste", () => {
  const ROLES = { kam: "MEDICAL_DELEGATE", dm: "PRODUCT_MANAGER", gm: "GENERAL_MANAGER", sa: "SUPER_ADMIN", dir: "DIRECTION" } as const;
  const u: Record<keyof typeof ROLES, string> = { kam: "", dm: "", gm: "", sa: "", dir: "" };
  const comme = async (qui: keyof typeof ROLES) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };
  const congres: string[] = [];
  const events: string[] = [];
  const docs: string[] = [];
  let envId = "", catId = "";

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({
      data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" },
    })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    const annee = new Date().getUTCFullYear();
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN} Budget Marketing`, domaine: "MARKETING", modules: ["CONGRESS_NATIONAL", "EVENTS"], totalAmount: 50_000_000,
        periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59)),
      },
    });
    envId = env.id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Événements`, allocated: 50_000_000 } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const parents = [...congres, ...events];
    const postes = (await prisma.adProItem.findMany({
      where: { OR: [{ congressNationalId: { in: congres } }, { eventId: { in: events } }] }, select: { id: true },
    }).catch(() => [])).map((p) => p.id);
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
    const tousDocs = [...new Set([...docs, ...liens.map((l) => l.legalDocumentId)])];
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: [...postes, ...tousDocs, ...parents] } } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: postes } }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: tousDocs } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: { in: [...parents, ...tousDocs] } }, select: { id: true } }).catch(() => []);
    const dossiers = await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } }, select: { id: true } }).catch(() => []);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: parents } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: tousDocs } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    const instances = await prisma.workflowInstance.findMany({ where: { entityId: { in: parents } }, select: { id: true } }).catch(() => []);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: instances.map((i) => i.id) } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: instances.map((i) => i.id) } } }).catch(() => {});
    for (const id of parents) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...parents, ...postes, ...tousDocs] } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: { in: congres } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { requesterId: { in: ids } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { OR: [{ id: { in: congres } }, { requesterId: { in: ids } }] } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { requesterId: { in: ids } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: events } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  /** Un congrès national PRÉVALIDÉ (requestStatus APPROVED), au nom du délégué. */
  async function congresPrevalide(nom: string): Promise<string> {
    const id = (await prisma.congressNational.create({ data: { name: `${RUN} ${nom}`, requesterId: u.kam, requestStatus: "APPROVED" } })).id;
    congres.push(id);
    return id;
  }

  // ─── ADPRO-01 ─────────────────────────────────────────────────────────────────────────────
  it("ADPRO-01 — la facture d'un POSTE ne part pas au règlement depuis Legal : pas d'ordre hors porte du DG ni en double", async () => {
    const parent = await congresPrevalide("Congrès de Sétif");
    // Total 2 000 000 > seuil, AUCUNE décision du DG : la porte est fermée pour cette demande.
    const poste = await prisma.adProItem.create({
      data: { congressNationalId: parent, kind: "PRINTING", label: `${TAG}Impression`, status: "APPROVED", amountGranted: 2_000_000, supplier: "Imprimerie Alpha" },
    });
    // La facture déposée sur le poste (`deposerFacturePoste`) : une pièce Legal INVOICE rattachée comme FACTURE.
    const facture = await prisma.legalDocument.create({
      data: {
        title: `${TAG}Facture impression`, kind: "INVOICE", direction: "OUT", amount: 2_000_000, counterparty: "Imprimerie Alpha",
        sourceType: "CONGRESS_NATIONAL", sourceId: parent,
      },
    });
    docs.push(facture.id);
    await prisma.adProItemPiece.create({ data: { itemId: poste.id, legalDocumentId: facture.id, nature: "FACTURE" } });

    await comme("sa");
    const r = await sendLegalInvoiceToSettlement(fd({ id: facture.id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/poste/);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: facture.id } })).toBe(0);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facture.id } })).expenseOrderId).toBeNull();
  });

  // ─── ADPRO-02 ─────────────────────────────────────────────────────────────────────────────
  it("ADPRO-02 — « Consommer » (Budget Marketing) n'émet pas d'ordre tant que le DG n'a pas validé le total", async () => {
    const eventId = (await prisma.event.create({ data: { name: `${RUN} Journées d'Oran`, requesterId: u.kam, requestStatus: "APPROVED" } })).id;
    events.push(eventId);
    const poste = await prisma.adProItem.create({
      data: { eventId, kind: "STAND", status: "APPROVED", label: `${TAG}Stand`, amountGranted: 3_000_000, supplier: "Expo Events DZ" },
    });
    const bc = await prisma.legalDocument.create({
      data: { title: `${TAG}BC stand`, kind: "PURCHASE_ORDER", reference: `${RUN}BC`, amount: 3_000_000, counterparty: "Expo Events DZ", signedAt: new Date() },
    });
    docs.push(bc.id);
    await prisma.adProItemPiece.create({ data: { itemId: poste.id, legalDocumentId: bc.id, nature: "BON_DE_COMMANDE" } });
    await comme("dm");
    const imp = await imputerDepensePoste(fd({ id: poste.id, categorieId: catId }));
    expect(imp.ok, imp.error).toBe(true);

    // Porte FERMÉE (3 000 000 > seuil, aucune décision) : rien ne part au centre de paiement.
    const refuse = await consommerDepensePoste(fd({ id: poste.id, montant: "2500000" }));
    expect(refuse.ok).toBe(false);
    expect(refuse.error).toMatch(/Directeur Général/);
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId } })).toBe(0);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: poste.id } })).orderStage).not.toBe("ISSUED");

    // Le DG valide le total : la consommation passe, un ordre et un seul.
    const v = await statuerSurLeTotal({ user: { id: u.gm, name: "gm", role: "GENERAL_MANAGER" }, parent: "EVENT", parentId: eventId, decision: "VALIDEE", totalVu: 3_000_000, note: null });
    expect(v.ok).toBe(true);
    await comme("dm");
    const ok = await consommerDepensePoste(fd({ id: poste.id, montant: "2500000" }));
    expect(ok.ok, ok.error).toBe(true);
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId } })).toBe(1);
  });

  // ─── ADPRO-03 ─────────────────────────────────────────────────────────────────────────────
  it("ADPRO-03 — la déclaration suit les postes jusqu'à zéro : aucun ordre GLOBAL sur une estimation de postes refusés", async () => {
    const parent = await congresPrevalide("Congrès de Batna");
    // Son circuit, conclu à la prévalidation SANS montant (27/10) : `WorkflowInstance.amount` reste vide.
    expect((await ensureInstance("CONGRESS_NATIONAL", parent))?.amount ?? null).toBeNull();
    // La déclaration née à la prévalidation, SANS montant (la prévalidation n'en fixe pas, 27/10).
    const decl = await prisma.medicalInfoDeclaration.create({
      data: { reference: `${RUN}DIM`, sourceType: "CONGRESS_NATIONAL", sourceId: parent, label: `${TAG}Congrès de Batna`, requesterId: u.kam, status: "AWAITING_DIRECTION" },
    });
    await comme("kam");
    const a = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: parent, kind: "PRINTING", label: `${TAG}Kakémonos`, amountEstimated: "1500000", supplier: "Imprimerie Alpha" }));
    expect(a.ok, a.error).toBe(true);
    expect(Number((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: decl.id } })).amount)).toBe(1_500_000);
    const s = await submitAdProItem(undefined, fd({ id: a.id! }));
    expect(s.ok, s.error).toBe(true);
    await comme("dm");
    const refus = await decideAdProItem(undefined, fd({ id: a.id!, decision: "REJECTED", note: "Hors budget de la gamme." }));
    expect(refus.ok, refus.error).toBe(true);

    // Plus aucun poste ne porte la dépense : la déclaration revient à ce que le circuit a fixé — rien.
    expect((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: decl.id } })).amount).toBeNull();
    await comme("sa");
    const v = await validateDeclarationByDirection(fd({ id: decl.id }));
    expect(v.ok, v.error).toBe(true);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "CONGRESS_NATIONAL", sourceId: parent } })).toBe(0);
  });

  // ─── ADPRO-04 ─────────────────────────────────────────────────────────────────────────────
  it("ADPRO-04 — la prise en charge créée par Adam naît comme à l'écran : dates exigées, circuit ouvert sur la route du créateur", async () => {
    const kam = await comme("kam");
    const sansFin = await performAction(kam, {
      kind: "create_congress_request", scope: "NATIONAL", name: `${RUN} Journée Adam sans fin`,
      specialty: null, city: "Oran", country: null, startDate: "2026-12-10", endDate: null, estimatedBudget: 800_000,
      doctorId: null, doctorName: null, note: null,
    } as Parameters<typeof performAction>[1]);
    expect(sansFin.ok).toBe(false);
    expect(await prisma.congressNational.count({ where: { name: `${RUN} Journée Adam sans fin` } })).toBe(0);

    const r = await performAction(kam, {
      kind: "create_congress_request", scope: "NATIONAL", name: `${RUN} Journée Adam`,
      specialty: null, city: "Oran", country: null, startDate: "2026-12-10", endDate: "2026-12-11", estimatedBudget: 800_000,
      doctorId: null, doctorName: null, note: null,
    } as Parameters<typeof performAction>[1]);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const cree = await prisma.congressNational.findFirstOrThrow({ where: { name: `${RUN} Journée Adam` } });
    congres.push(cree.id);
    expect(cree.endDate).not.toBeNull();
    // LE CIRCUIT EST NÉ AVEC LA DEMANDE (décision #1) : un délégué entre chez son National Sales.
    const inst = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType: "CONGRESS_NATIONAL", entityId: cree.id } } });
    expect(inst?.status).toBe("IN_PROGRESS");
    expect(inst?.currentSlug).toBe("preliminary");
  });
});
