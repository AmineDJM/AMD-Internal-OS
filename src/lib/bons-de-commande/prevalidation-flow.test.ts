import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createLegalDocument, adresserBCAuCentre, updateLegalDocument } from "@/lib/actions/legal-actions";
import { etatCompletDuBC } from "./etat-bc-test-outils";
import {
  createValidationRequest, decideValidation, demanderValidationFinaleBC, deleteMyValidationRequest,
} from "@/lib/actions/validation-actions";
import { porteDuBC, aiguillerBC } from "./aiguillage";
import { OBJET_PREVALIDATION_BC } from "./prevalidation";
import { bcImportables } from "./retenue-bc";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bcprevalid__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[] | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.set(k, v);
  }
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PRÉ-VALIDATION D'UN BC — par les VRAIS points d'entrée (Direction, 10/2026).
 *
 * « L'objet à valider est un bon de commande ; les validateurs choisis acceptent ; le demandeur demande la validation
 * FINALE, qui va au centre de validation des BC, puis, acceptée, au module Bons de commande. » Ce banc suit ce
 * parcours de bout en bout et vérifie la propriété qui compte : AUCUN centre ne voit le BC tant que la pré-validation
 * court, et aucune porte dérobée (« Adresser au centre », réaiguillage) ne l'y envoie avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Pré-validation d'un BC depuis « Demandes de validations » — le flux réel", () => {
  let assistanteId = "", saId = "", dirId = "", gmId = "", contactId = "";
  const docs: string[] = [];

  const creerBC = async (suffix: string): Promise<string> => {
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} ${suffix}`, reference: `${TAG}${suffix}`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: "250000",
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    return r.id!;
  };
  const demandeDe = (docId: string) => prisma.validationRequest.findFirstOrThrow({
    where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: OBJET_PREVALIDATION_BC },
    include: { steps: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
  });

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    assistanteId = (await mk("assistante", "DIRECTION_ASSISTANT")).id;
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    dirId = (await mk("dir", "DIRECTION")).id;
    gmId = (await mk("gm", "GENERAL_MANAGER")).id;
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, companyId: null } })).id;
  });

  afterAll(async () => {
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: { in: ["LEGAL_DOCUMENT", "VALIDATION_REQUEST"] }, entityId: { in: [...docs, ...vIds] } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    await prisma.notification.deleteMany({ where: { userId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("importé depuis Legal : la porte du centre est RETIRÉE, la pré-validation part chez les validateurs choisis, dans l'ordre", async () => {
    const docId = await creerBC("IMPORT");
    expect(await porteDuBC(docId)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });

    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    expect((await bcImportables(ACTOR)).some((b) => b.id === docId)).toBe(true);
    const r = await createValidationRequest(undefined, form({
      title: `${TAG} Pré-validation stand`, objectKind: "BON_DE_COMMANDE", bcSource: "LEGAL", legalDocumentId: docId,
      validatorId: [dirId, gmId],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);

    expect(await porteDuBC(docId)).toBeNull();
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.bcPrevalidationAt).not.toBeNull();
    expect(doc.bcPrevalidationRequestId).toBe(r.id);
    const d = await demandeDe(docId);
    expect(d.steps.map((s) => s.validatorId)).toEqual([dirId, gmId]);
    expect(d.amount && Number(d.amount)).toBe(250000);
    // Plus importable : il est retenu.
    expect((await bcImportables(ACTOR)).some((b) => b.id === docId)).toBe(false);
  });

  it("AUCUNE porte dérobée pendant la pré-validation : ni « Adresser au centre », ni le réaiguillage", async () => {
    const docId = docs[0];
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const adresse = await adresserBCAuCentre(form({ id: docId }));
    expect(adresse.ok).toBe(false);
    if (!adresse.ok) expect(adresse.error).toMatch(/pré-validation/);
    const a = await aiguillerBC(docId, { acteurId: assistanteId });
    expect(a.enPrevalidation).toBe(true);
    expect(await porteDuBC(docId)).toBeNull();
  });

  it("la validation finale reste fermée tant que TOUS n'ont pas accepté, puis l'adresse au centre — une seule fois", async () => {
    const docId = docs[0];
    const d = await demandeDe(docId);
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const tot = await demanderValidationFinaleBC(form({ id: d.id }));
    expect(tot.ok).toBe(false);

    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await decideValidation(form({ stepId: d.steps[0].id, decision: "APPROVED" }))).ok).toBe(true);
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    expect((await demanderValidationFinaleBC(form({ id: d.id }))).ok).toBe(false);

    ACTOR = await actorFor(gmId, "GENERAL_MANAGER");
    expect((await decideValidation(form({ stepId: d.steps[1].id, decision: "APPROVED" }))).ok).toBe(true);

    // Un autre que le demandeur ne la demande pas.
    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await demanderValidationFinaleBC(form({ id: d.id }))).ok).toBe(false);

    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const fin = await demanderValidationFinaleBC(form({ id: d.id }));
    expect(fin.ok, fin.ok === false ? fin.error : "").toBe(true);
    if (fin.ok) expect(fin.message).toMatch(/centre de validations/);
    expect(await porteDuBC(docId)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.bcPrevalidationAt).toBeNull();
    expect(doc.bcCircuitAt).not.toBeNull();

    const encore = await demanderValidationFinaleBC(form({ id: d.id }));
    expect(encore.ok).toBe(false);
  });

  it("déposé depuis l'ordinateur : enregistré au registre Legal, né retenu — aucun centre ne le voit", async () => {
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const fichier = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], "bc-imprimerie.pdf", { type: "application/pdf" });
    const r = await createValidationRequest(undefined, form({
      title: `${TAG} BC déposé`, objectKind: "BON_DE_COMMANDE", bcSource: "ORDINATEUR",
      bcFile: fichier, bcCounterpartyIds: contactId, bcAmount: "120000", bcReference: `${TAG}DEPOSE`,
      validatorId: [dirId],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const d = await prisma.validationRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(d.objectType).toBe(OBJET_PREVALIDATION_BC);
    docs.push(d.entityId!);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: d.entityId! } });
    expect(doc.kind).toBe("PURCHASE_ORDER");
    expect(Number(doc.amount)).toBe(120000);
    expect(doc.bcPrevalidationRequestId).toBe(r.id);
    expect(await porteDuBC(doc.id)).toBeNull();
    expect(await prisma.validationRequest.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id, objectType: "BON_DE_COMMANDE" } })).toBe(0);
  });

  it("SON NUMÉRO SEUL SE MODIFIE (Direction, 14/10/2026) : la pré-validation et ses validateurs restent où ils en sont ; tracé", async () => {
    const id = docs.at(-1)!;
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { title: true, reference: true, amount: true } });
    const avant = await etatCompletDuBC(id);
    const prevalidation = await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: id }, select: { id: true, status: true, steps: { select: { id: true, status: true } } } });
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await updateLegalDocument(form({ id, title: doc.title, reference: `${TAG}DEPOSE-2`, kind: "PURCHASE_ORDER", amount: String(Number(doc.amount)), counterpartyIds: contactId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(r.message).toMatch(/Seul le numéro a changé/);
    expect(await etatCompletDuBC(id)).toEqual(avant);
    expect(await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: id }, select: { id: true, status: true, steps: { select: { id: true, status: true } } } })).toEqual(prevalidation);
    expect(await porteDuBC(id)).toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { entityId: id, field: "numero" }, select: { oldValue: true, newValue: true } })).toEqual({ oldValue: doc.reference, newValue: `${TAG}DEPOSE-2` });
    await prisma.auditLog.deleteMany({ where: { entityId: id } });
  });

  it("retirée par son demandeur, la pré-validation rend le BC au circuit ordinaire (son centre)", async () => {
    const docId = await creerBC("RETRAIT");
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const r = await createValidationRequest(undefined, form({
      title: `${TAG} à retirer`, objectKind: "BON_DE_COMMANDE", bcSource: "LEGAL", legalDocumentId: docId, validatorId: [dirId],
    }));
    expect(r.ok).toBe(true);
    expect(await porteDuBC(docId)).toBeNull();
    const retrait = await deleteMyValidationRequest(form({ id: r.id! }));
    expect(retrait.ok, retrait.ok === false ? retrait.error : "").toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.bcPrevalidationAt).toBeNull();
    expect(await porteDuBC(docId)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
  });

  it("refuse un BC déjà validé par son centre, et une demande sans validateur principal", async () => {
    const docId = await creerBC("VALIDE");
    const porte = await prisma.validationRequest.findFirstOrThrow({ where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: "BON_DE_COMMANDE" }, include: { steps: true } });
    ACTOR = await actorFor(porte.steps[0].validatorId, (await prisma.user.findUniqueOrThrow({ where: { id: porte.steps[0].validatorId } })).role);
    expect((await decideValidation(form({ stepId: porte.steps[0].id, decision: "APPROVED" }))).ok).toBe(true);

    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const r = await createValidationRequest(undefined, form({
      title: `${TAG} trop tard`, objectKind: "BON_DE_COMMANDE", bcSource: "LEGAL", legalDocumentId: docId, validatorId: [dirId],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/déjà validé/);

    const sans = await createValidationRequest(undefined, form({ title: `${TAG} sans validateur`, objectKind: "BON_DE_COMMANDE", bcSource: "LEGAL", legalDocumentId: docId }));
    expect(sans.ok).toBe(false);
    void saId;
  });
});
