import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestDocument, submitDocumentRequest, decideDocumentRequest } from "./document-request-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pieceLegal__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * UNE PIÈCE RÉCLAMÉE QUI ENGAGE LA SOCIÉTÉ REJOINT LEGAL — vérifié par les VRAIES actions.
 *
 * Le module pur `legal/from-piece.ts` dit ce que la règle DÉCIDE ; ici on vérifie qu'elle est
 * APPLIQUÉE par le circuit réel, et surtout les deux points où l'on se trompe :
 *   • LES LECTEURS SUIVENT — classer une facture ne doit pas l'exposer à tout le module ;
 *   • LE FICHIER DÉMÉNAGE — un fichier, un seul domicile ; deux copies divergent.
 */
suite("Une pièce acceptée rejoint le registre des engagements", () => {
  let demandeurId = "", deposantId = "";
  const requests: string[] = [];
  const legalIds: string[] = [];

  beforeAll(async () => {
    const mk = (suffix: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${suffix}`, email: `${TAG}${suffix}@t.dz`, role, passwordHash: "x" } });
    const [a, b] = await Promise.all([mk("dem", "DIRECTION"), mk("dep", "DIRECTION_ASSISTANT")]);
    demandeurId = a.id; deposantId = b.id;
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: legalIds } } }).catch(() => {});
    // Les PORTES des BC classés (§118.148) — leur demandeur est un compte du banc.
    await prisma.validationRequest.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: legalIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: legalIds } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legalIds } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { id: { in: requests } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** Réclamer une pièce d'une nature donnée, la déposer, et la faire accepter. */
  async function cycle(kind: string, label = `${TAG} la facture définitive`) {
    ACTOR = await actorFor(demandeurId, "DIRECTION");
    const fd = new FormData();
    fd.set("entityType", "PAYMENT_REQUEST"); fd.set("entityId", `pr-${Math.random().toString(36).slice(2)}`);
    fd.set("label", label); fd.set("kind", kind); fd.set("askedToId", deposantId);
    const demande = await requestDocument(fd);
    expect(demande.ok, demande.error).toBe(true);
    requests.push(demande.id!);

    // Le dépôt réel : un Document rattaché à la demande, puis le signalement.
    const doc = await prisma.document.create({
      data: {
        name: `${TAG}piece.pdf`, entityType: "DOCUMENT_REQUEST", entityId: demande.id!,
        fileKey: "k", mimeType: "application/pdf", sizeBytes: 10, category: "INVOICE",
        confidentiality: "INTERNAL", uploadedById: deposantId,
      },
      select: { id: true },
    });
    ACTOR = await actorFor(deposantId, "DIRECTION_ASSISTANT");
    const dep = new FormData();
    dep.set("id", demande.id!);
    expect((await submitDocumentRequest(dep)).ok).toBe(true);

    ACTOR = await actorFor(demandeurId, "DIRECTION");
    const acc = new FormData();
    acc.set("id", demande.id!); acc.set("accept", "1");
    const decision = await decideDocumentRequest(acc);
    expect(decision.ok, decision.error).toBe(true);
    const apres = await prisma.documentRequest.findUniqueOrThrow({ where: { id: demande.id! } });
    if (apres.legalDocumentId) legalIds.push(apres.legalDocumentId);
    return { requestId: demande.id!, documentId: doc.id, apres, decision };
  }

  it("UNE FACTURE ACCEPTÉE DEVIENT UNE PIÈCE LEGAL, sous sa nature", async () => {
    const { apres, decision } = await cycle("INVOICE");
    expect(apres.legalDocumentId).toBeTruthy();
    expect(decision.message).toMatch(/Legal/);
    const legal = await prisma.legalDocument.findUniqueOrThrow({ where: { id: apres.legalDocumentId! } });
    expect(legal.kind).toBe("INVOICE");
    expect(legal.title).toContain(apres.reference);
    expect(legal.sourceType).toBe("DOCUMENT_REQUEST");
    expect(legal.sourceId).toBe(apres.id);
    // RIEN N'EST INVENTÉ à partir d'un fichier qu'on n'a pas lu.
    expect(legal.reference).toBeNull();
    expect(legal.amount).toBeNull();
    expect(legal.counterparty).toBeNull();
  });

  it("LES LECTEURS SUIVENT — classer ne doit pas exposer la facture à tout le module", async () => {
    const { apres } = await cycle("INVOICE");
    const lecteurs = await prisma.legalDocumentReader.findMany({
      where: { documentId: apres.legalDocumentId! }, select: { userId: true },
    });
    const ids = lecteurs.map((l) => l.userId);
    expect(ids).toContain(demandeurId);
    expect(ids).toContain(deposantId);
    // Un document Legal SANS lecteur est visible de tout le module : la liste ne doit pas être vide.
    expect(ids.length).toBeGreaterThan(0);
  });

  it("LE FICHIER DÉMÉNAGE — un fichier, un seul domicile", async () => {
    const { documentId, apres, decision } = await cycle("PURCHASE_ORDER");
    // Classé comme BON DE COMMANDE, il attend son centre — et la phrase de l'acceptation le DIT :
    // « enregistrée dans Legal » seul le ferait envoyer au fournisseur (§118.32, §118.148).
    expect(decision.message).toMatch(/attend la validation du centre de validations/);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.entityType).toBe("LEGAL_DOCUMENT");
    expect(doc.entityId).toBe(apres.legalDocumentId);
    // Et il n'a pas été RECOPIÉ : une seule ligne pour ce fichier.
    expect(await prisma.document.count({ where: { name: `${TAG}piece.pdf`, entityId: apres.legalDocumentId! } })).toBe(1);
  });

  it("UN BON DE LIVRAISON N'Y VA PAS — Legal est le registre de ce qui ENGAGE, pas un second Drive", async () => {
    const { apres, documentId, decision } = await cycle("DELIVERY_NOTE", `${TAG} le bon de livraison`);
    expect(apres.legalDocumentId).toBeNull();
    expect(decision.message).toBeUndefined();
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.entityType).toBe("DOCUMENT_REQUEST");
  });

  it("UNE NATURE NON DÉCLARÉE VAUT « Autre » — et n'entre pas au registre par défaut", async () => {
    const { apres } = await cycle("", `${TAG} une pièce sans nature`);
    expect(apres.kind).toBe("OTHER");
    expect(apres.legalDocumentId).toBeNull();
  });
});
