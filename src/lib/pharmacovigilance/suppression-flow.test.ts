import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { deleteOwnRecord, restoreDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { peutSupprimerLeCasPv } from "@/lib/pharmacovigilance/regles";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pvsup__";

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

// Rôle et droits lus EN BASE (la matrice fait foi, aucun accès forgé).
async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const supprimer = (id: string) => deleteOwnRecord(form({ kind: "PHARMACOVIGILANCE_CASE", id }));
const existe = (id: string) => prisma.pharmacovigilanceCase.findUnique({ where: { id }, select: { id: true } }).then((c) => c !== null);

describe("peutSupprimerLeCasPv — la règle de l'écran", () => {
  const cas = { reporterId: "kam" };
  it("le KAM qui a signalé le cas, et le Super Admin", () => {
    expect(peutSupprimerLeCasPv({ userId: "kam" }, cas)).toBe(true);
    expect(peutSupprimerLeCasPv({ userId: "admin", superAdmin: true }, cas)).toBe(true);
  });
  it("personne d'autre — Regulatory ou un participant non plus", () => {
    expect(peutSupprimerLeCasPv({ userId: "regulatory" }, cas)).toBe(false);
    expect(peutSupprimerLeCasPv({ userId: "regulatory", superAdmin: false }, cas)).toBe(false);
  });
});

/**
 * SUPPRIMER UN CAS DE PHARMACOVIGILANCE (Direction, 08/11) — par le vrai point d'entrée (`deleteOwnRecord`) :
 *   1. le KAM qui a signalé le cas le supprime, à TOUT statut (même clos) ;
 *   2. Regulatory (qui instruit) et un participant à l'échange sont refusés — le cas reste ;
 *   3. le Super Admin supprime le cas d'un autre ;
 *   4. la suppression est un LOT de corbeille : pièces, fil et participants partent, l'audit est écrit, et la
 *      restauration rend le tout.
 */
suite("supprimer un cas de pharmacovigilance (flux réel)", () => {
  let adminId = "", kamId = "", autreKamId = "", regulatoryId = "";
  let casAnalyse = "", casClos = "", casAutre = "";
  let pieceId = "", commentaireId = "";

  const creerCas = (suffix: string, reporterId: string, status: "RECU" | "EN_ANALYSE" | "ENQUETE" | "CLOS") =>
    prisma.pharmacovigilanceCase.create({
      data: {
        reference: `${TAG}${suffix}`, reporterId, status, productLabel: `${TAG}raltégravir`, institutionName: `${TAG}El Kettar`,
        occurredOn: new Date("2026-10-01"), description: `${TAG} effet indésirable observé`,
        ...(status === "CLOS" ? { closedAt: new Date(), closedById: regulatoryId, closingNote: "Conclu." } : {}),
      },
      select: { id: true },
    }).then((c) => c.id);

  const nettoyer = async () => {
    const ids = (await prisma.pharmacovigilanceCase.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.deletedRecord.deleteMany({ where: { kind: "PHARMACOVIGILANCE_CASE", name: { contains: TAG } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { body: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.pharmacovigilanceCase.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    adminId = (await mk("admin", "SUPER_ADMIN")).id;
    kamId = (await mk("kam", "MEDICAL_DELEGATE")).id;
    autreKamId = (await mk("autre-kam", "MEDICAL_DELEGATE")).id;
    regulatoryId = (await mk("regulatory", "HEAD_OF_REGULATORY")).id;

    casAnalyse = await creerCas("PV-1", kamId, "EN_ANALYSE");
    casClos = await creerCas("PV-2", kamId, "CLOS");
    casAutre = await creerCas("PV-3", autreKamId, "RECU");
    // Le cas en analyse a une pièce, un message et un participant (l'autre KAM, ajouté à l'échange).
    pieceId = (await prisma.document.create({
      data: { name: `${TAG}photo.jpg`, category: "PHOTO", entityType: "PHARMACOVIGILANCE_CASE", entityId: casAnalyse, uploadedById: kamId },
      select: { id: true },
    })).id;
    commentaireId = (await prisma.comment.create({
      data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: casAnalyse, authorId: regulatoryId, body: `${TAG}pris en analyse` },
      select: { id: true },
    })).id;
    await prisma.pharmacovigilanceParticipant.create({ data: { caseId: casAnalyse, userId: autreKamId, addedById: regulatoryId } });
  });

  afterAll(nettoyer);

  it("Regulatory (qui instruit) ne supprime pas un cas qu'il n'a pas signalé", async () => {
    ACTOR = await actorFor(regulatoryId);
    const r = await supprimer(casAnalyse);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/créateur/);
    expect(await existe(casAnalyse)).toBe(true);
  });

  it("un participant à l'échange ne le supprime pas non plus", async () => {
    ACTOR = await actorFor(autreKamId);
    const r = await supprimer(casAnalyse);
    expect(r.ok).toBe(false);
    expect(await existe(casAnalyse)).toBe(true);
  });

  it("le KAM qui l'a signalé le supprime — en analyse — avec ses pièces, son fil et ses participants, audit écrit", async () => {
    ACTOR = await actorFor(kamId);
    const r = await supprimer(casAnalyse);
    expect(r).toMatchObject({ ok: true });
    expect(await existe(casAnalyse)).toBe(false);
    expect(await prisma.document.findUnique({ where: { id: pieceId } })).toBeNull();
    expect(await prisma.comment.findUnique({ where: { id: commentaireId } })).toBeNull();
    expect(await prisma.pharmacovigilanceParticipant.count({ where: { caseId: casAnalyse } })).toBe(0);

    const corbeille = await prisma.deletedRecord.findFirst({ where: { kind: "PHARMACOVIGILANCE_CASE", sourceId: casAnalyse } });
    expect(corbeille?.deletedById).toBe(kamId);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: casAnalyse, action: "DELETE" } });
    expect(audit?.actorId).toBe(kamId);
    expect(audit?.entityType).toBe("PHARMACOVIGILANCE_CASE");
  });

  it("la restauration (Super Admin) rend le cas avec sa pièce, son fil et son participant", async () => {
    const corbeille = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "PHARMACOVIGILANCE_CASE", sourceId: casAnalyse } });
    ACTOR = await actorFor(adminId);
    const r = await restoreDeletedRecord(form({ id: corbeille.id }));
    expect(r).toMatchObject({ ok: true });
    expect(await existe(casAnalyse)).toBe(true);
    expect(await prisma.document.findUnique({ where: { id: pieceId } })).not.toBeNull();
    expect(await prisma.comment.findUnique({ where: { id: commentaireId } })).not.toBeNull();
    expect(await prisma.pharmacovigilanceParticipant.count({ where: { caseId: casAnalyse, userId: autreKamId } })).toBe(1);
  });

  it("le KAM supprime aussi un cas CLOS : tout statut (Direction, 08/11)", async () => {
    ACTOR = await actorFor(kamId);
    expect(await supprimer(casClos)).toMatchObject({ ok: true });
    expect(await existe(casClos)).toBe(false);
  });

  it("un KAM ne supprime pas le cas d'un autre KAM", async () => {
    ACTOR = await actorFor(kamId);
    expect((await supprimer(casAutre)).ok).toBe(false);
    expect(await existe(casAutre)).toBe(true);
  });

  it("le Super Admin supprime le cas d'un autre", async () => {
    ACTOR = await actorFor(adminId);
    expect(await supprimer(casAutre)).toMatchObject({ ok: true });
    expect(await existe(casAutre)).toBe(false);
  });
});
