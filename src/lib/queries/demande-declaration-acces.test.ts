import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { addRequestComment } from "@/lib/actions/admin-request-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE DEMANDE SE COMMENTE DEPUIS SA FICHE, UNE DÉCLARATION SE LIT DEPUIS LA SIENNE
 * (§118.184 — audit 360°, S12).
 *
 * Mesuré par l'audit : `addRequestComment` ne vérifiait rien — n'importe quel compte écrivait sur une
 * demande par son identifiant, et le demandeur recevait la notification. Et les pièces d'une déclaration
 * d'information médicale retombaient sur le droit de MODULE : le gestionnaire budgétaire (lecture et dépôt
 * sur le module, portée « ses lignes ») téléchargeait les pièces de TOUTES les déclarations, quand la
 * fiche ne lui ouvre que celles où une pièce lui est demandée. Joué avec les vrais rôles par défaut.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__demdecl__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("demandes au secrétariat et déclarations — la règle de la fiche", () => {
  const u: Record<string, string> = {};
  const acteurs: Record<string, SessionUser> = {};
  let demande = "", declaration = "";

  async function nettoyer() {
    const reqs = await prisma.administrativeRequest.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    const decls = await prisma.medicalInfoDeclaration.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    const ids = [...reqs.map((x) => x.id), ...decls.map((x) => x.id)];
    const vrs = await prisma.validationRequest.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vrs.map((x) => x.id) } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vrs.map((x) => x.id) } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { body: { contains: TAG }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }).catch(() => {});
    await prisma.medicalInfoDocRequest.deleteMany({ where: { declarationId: { in: decls.map((x) => x.id) } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: decls.map((x) => x.id) } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: reqs.map((x) => x.id) } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: string) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" } })).id;
    };
    await mk("demandeur", "VIEWER");
    await mk("inconnu", "VIEWER");
    await mk("validateur", "VIEWER");
    await mk("finance", "FINANCE_BUDGET_MANAGER");
    await mk("financeSollicitee", "FINANCE_BUDGET_MANAGER");
    await mk("pharmacien", "MEDICAL_INFO_PHARMACIST");
    await mk("porteeTout", "VIEWER");
    // Une portée ALL posée par la console, sans le droit de valider : la LISTE lui montre tout.
    await prisma.userAccess.create({ data: { userId: u.porteeTout, module: "MEDICAL_INFO", canView: true, scope: "ALL" } });
    for (const [k, id] of Object.entries(u)) {
      const role = (await prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role;
      acteurs[k] = { id, role, secondaryRole: null, access: await getAccess(id, role) } as unknown as SessionUser;
    }

    demande = (await prisma.administrativeRequest.create({
      data: { reference: `${TAG}REQ`, title: `${TAG}Courrier`, type: "MAIL", requesterId: u.demandeur },
    })).id;
    // Le validateur d'une PIÈCE voit la demande entière, même hors de son périmètre (la fiche le dit).
    const piece = await prisma.document.create({ data: { name: `${TAG}facture.pdf`, entityType: "ADMIN_REQUEST", entityId: demande } });
    const vr = await prisma.validationRequest.create({
      data: { reference: `${TAG}VAL`, module: "Demandes administratives", title: `${TAG}validation`, requesterId: u.demandeur, entityType: "ADMIN_REQUEST", entityId: demande, documentId: piece.id },
    });
    await prisma.validationStep.create({ data: { requestId: vr.id, order: 1, validatorId: u.validateur } });

    declaration = (await prisma.medicalInfoDeclaration.create({
      data: { reference: `${TAG}DIM`, sourceType: "SPONSORING", sourceId: `${TAG}source`, label: `${TAG}Congrès` },
    })).id;
    await prisma.medicalInfoDocRequest.create({ data: { declarationId: declaration, label: `${TAG}attestation`, targetUserId: u.financeSollicitee } });
    await prisma.document.create({ data: { name: `${TAG}recepisse.pdf`, entityType: "MEDICAL_INFO_DECLARATION", entityId: declaration } });
  });

  afterAll(async () => { await nettoyer(); });

  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

  it("COMMENTER : refusé à qui ne lit pas la demande — rien n'est écrit, personne n'est prévenu", async () => {
    ACTEUR = acteurs.inconnu;
    expect(await addRequestComment(fd({ requestId: demande, body: `${TAG}intrusion` }))).toEqual({ ok: false, error: "Demande introuvable." });
    expect(await prisma.comment.count({ where: { entityId: demande } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: u.demandeur, body: { contains: `${TAG}intrusion` } } })).toBe(0);
  });

  it("COMMENTER : le demandeur, et le validateur d'une pièce (hors de son périmètre), commentent", async () => {
    ACTEUR = acteurs.demandeur;
    expect((await addRequestComment(fd({ requestId: demande, body: `${TAG}relance` }))).ok).toBe(true);
    ACTEUR = acteurs.validateur;
    expect((await addRequestComment(fd({ requestId: demande, body: `${TAG}vu` }))).ok).toBe(true);
    expect(await prisma.comment.count({ where: { entityId: demande } })).toBe(2);
  });

  it("PRÉMISSE : le gestionnaire budgétaire a le module Information médicale en lecture et dépôt, portée « ses lignes »", () => {
    const m = acteurs.finance.access.modules.get("MEDICAL_INFO");
    expect(m?.actions.has("VIEW")).toBe(true);
    expect(m?.actions.has("UPLOAD")).toBe(true);
    expect(m?.scope).toBe("ASSIGNED");
  });

  it("LES PIÈCES D'UNE DÉCLARATION suivent sa fiche : pas pour qui n'y est pas sollicité ; oui pour qui l'est — sans pouvoir y toucher", async () => {
    expect(await canAccessEntity(acteurs.finance, "MEDICAL_INFO_DECLARATION", declaration, "VIEW")).toBe(false);
    expect(await canAccessEntity(acteurs.financeSollicitee, "MEDICAL_INFO_DECLARATION", declaration, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.financeSollicitee, "MEDICAL_INFO_DECLARATION", declaration, "UPLOAD")).toBe(false);
    expect(await canAccessEntity(acteurs.financeSollicitee, "MEDICAL_INFO_DECLARATION", declaration, "DELETE")).toBe(false);
  });

  it("LE PHARMACIEN instruit : il lit et gère les pièces ; une portée ALL de la console lit, comme la liste le lui montre", async () => {
    expect(await canAccessEntity(acteurs.pharmacien, "MEDICAL_INFO_DECLARATION", declaration, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.pharmacien, "MEDICAL_INFO_DECLARATION", declaration, "DELETE")).toBe(true);
    expect(await canAccessEntity(acteurs.porteeTout, "MEDICAL_INFO_DECLARATION", declaration, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.porteeTout, "MEDICAL_INFO_DECLARATION", declaration, "DELETE")).toBe(false);
  });

  it("POINT D'APPEL : la fiche d'une demande lit la même clause que le commentaire", () => {
    const fiche = readFileSync("src/app/(app)/demandes/[id]/page.tsx", "utf8");
    expect(fiche).toMatch(/where: await clauseDemandeLisible\(user, params\.id\)/);
    const actions = readFileSync("src/lib/actions/admin-request-actions.ts", "utf8");
    expect(actions).toMatch(/where: await clauseDemandeLisible\(user, requestId\)/);
  });
});
