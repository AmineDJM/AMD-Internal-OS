import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { actsForUser } from "@/lib/hr/stand-in-resolve";
import { tientPourLaSollicitee } from "@/lib/doc-request-interim";
import { canSubmit } from "@/lib/doc-request";
import { reaffecterDemandeBC, submitDocumentRequest } from "./document-request-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « QUI EST L'ASSISTANTE » (audit Assistante de direction, 10/2026).
 *
 *   • Un compte dont le rôle SECONDAIRE est « assistante de direction » est notifié comme elle (`notifyRoles` lit les
 *     deux rôles) mais la porte des pièces ne lisait que le rôle principal : il ouvrait la notification et recevait
 *     « Accès refusé ». La reconnaissance est alignée (principal OU secondaire).
 *   • Le BC d'un poste Ad & Pro part chez UNE assistante nommée : absente, la demande restait figée. Son INTÉRIMAIRE
 *     (`actsForUser`) dépose désormais à sa place, et la demande se RÉAFFECTE à une autre assistante active.
 * Par les VRAIES actions et la VRAIE porte (`canAccessEntity`), sans vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__assistante2nd__${Date.now()}`;
const DEBUT = new Date(Date.now() - 60_000);
const jour = (d: number) => new Date(Date.now() + d * 86_400_000);

async function actorFor(id: string, role: UserRole, secondaryRole: UserRole | null = null): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole, access, mustChangePassword: false };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("L'assistante de direction — rôle secondaire reconnu, intérim et réaffectation du BC d'un poste", () => {
  let pmId = "", daId = "", da2Id = "", interimId = "", horsId = "", companyId = "", promoId = "", demandeAdminId = "";
  const employes: string[] = [];
  const conges: string[] = [];
  const pieces: string[] = [];
  let PM: CurrentUser, DA2: CurrentUser, INTERIM: CurrentUser, HORS: CurrentUser;

  const demandeBC = async (kind = "PURCHASE_ORDER", entityType: "AD_PRO_ITEM" | "SPONSORING" = "AD_PRO_ITEM") => {
    const r = await prisma.documentRequest.create({
      data: {
        reference: `${TAG}-${pieces.length}`, entityType, entityId: `${TAG}poste`, label: `${TAG} Bon de commande — Imprimerie`,
        kind, askedById: pmId, askedToId: daId, status: "PENDING",
      },
      select: { id: true },
    });
    pieces.push(r.id);
    return r.id;
  };

  beforeAll(async () => {
    const mk = (n: string, role: UserRole, secondaryRole: UserRole | null = null) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, secondaryRole, passwordHash: "x" } });
    const [pm, da, da2, interim, hors] = await Promise.all([
      mk("dm", "PRODUCT_MANAGER"), mk("da", "DIRECTION_ASSISTANT"), mk("da2", "COORDINATOR", "DIRECTION_ASSISTANT"),
      mk("interim", "COORDINATOR"), mk("hors", "COORDINATOR"),
    ]);
    pmId = pm.id; daId = da.id; da2Id = da2.id; interimId = interim.id; horsId = hors.id;
    companyId = (await prisma.company.create({ data: { name: `${TAG}société` } })).id;
    promoId = (await prisma.promoMaterial.create({ data: { reference: `${TAG}MP`, title: `${TAG}MP`, companyId, requesterId: pmId } })).id;
    demandeAdminId = (await prisma.administrativeRequest.create({ data: { reference: `${TAG}DEM`, title: `${TAG}demande`, type: "QUOTE", requesterId: pmId } })).id;
    // L'INTÉRIM : congé de l'assistante accordé, intérimaire validé, en cours aujourd'hui.
    const [eDa, eInterim] = await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} da`, userId: daId, companyId, isActive: true } }),
      prisma.employee.create({ data: { fullName: `${TAG} interim`, userId: interimId, companyId, isActive: true } }),
    ]);
    employes.push(eDa.id, eInterim.id);
    conges.push((await prisma.leaveRequest.create({
      data: {
        employeeId: eDa.id, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
        standInId: interimId, standInStatus: "APPROVED", standInModules: ["ADMIN_REQUESTS"],
      },
    })).id);
    PM = await actorFor(pmId, "PRODUCT_MANAGER");
    DA2 = await actorFor(da2Id, "COORDINATOR", "DIRECTION_ASSISTANT");
    INTERIM = await actorFor(interimId, "COORDINATOR");
    HORS = await actorFor(horsId, "COORDINATOR");
  }, 60_000);

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { entityType: "DOCUMENT_REQUEST", entityId: { in: pieces } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: demandeAdminId } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: promoId } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { id: { in: conges } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: employes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { createdAt: { gte: DEBUT }, OR: [{ user: { email: { startsWith: TAG } } }, { body: { contains: TAG } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [pmId, daId, da2Id, interimId, horsId] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("PRÉMISSES : personne n'a la vue globale ; l'intérimaire remplace l'assistante aujourd'hui", async () => {
    for (const a of [PM, DA2, INTERIM, HORS]) expect(hasGlobalView(a), a.name).toBe(false);
    expect(await actsForUser(interimId, daId)).toBe(true);
    expect(await actsForUser(horsId, daId)).toBe(false);
  });

  it("RÔLE SECONDAIRE : l'assistante notifiée par son « autre rôle » ouvre les pièces du dossier promo et de la demande au secrétariat", async () => {
    for (const [type, id] of [["PROMO_MATERIAL", promoId], ["ADMIN_REQUEST", demandeAdminId]] as const) {
      expect(await canAccessEntity(DA2, type, id, "VIEW"), `${type} — rôle secondaire`).toBe(true);
      expect(await canAccessEntity(DA2, type, id, "UPLOAD"), `${type} — rôle secondaire`).toBe(true);
      // Modérer les pièces (renommer, retirer) : le geste du secrétariat, que son seul rôle principal n'ouvre pas.
      expect(await canAccessEntity(DA2, type, id, "DELETE"), `${type} — rôle secondaire`).toBe(true);
      expect(await canAccessEntity(HORS, type, id, "DELETE"), `${type} — sans le rôle`).toBe(false);
    }
  });

  it("INTÉRIM : l'intérimaire dépose le BC d'un poste à la place de l'assistante absente — pas une autre pièce, et pas un tiers", async () => {
    const bc = await demandeBC();
    const autre = await demandeBC("OTHER", "SPONSORING");
    const lue = await prisma.documentRequest.findUniqueOrThrow({ where: { id: bc } });
    expect(await tientPourLaSollicitee(interimId, lue)).toBe(true);
    expect(canSubmit(lue, interimId, true)).toBe(true);
    // La porte des pièces du fil : l'intérimaire y joint le BC ; un tiers non.
    expect(await canAccessEntity(INTERIM, "DOCUMENT_REQUEST", bc, "UPLOAD")).toBe(true);
    expect(await canAccessEntity(HORS, "DOCUMENT_REQUEST", bc, "UPLOAD")).toBe(false);
    // Une pièce qui n'est pas le BC d'un poste reste à la personne sollicitée.
    expect(await canAccessEntity(INTERIM, "DOCUMENT_REQUEST", autre, "UPLOAD")).toBe(false);

    await prisma.document.create({
      data: { name: "bc.pdf", category: "INVOICE", entityType: "DOCUMENT_REQUEST", entityId: bc, confidentiality: "INTERNAL", uploadedById: interimId },
    });
    ACTOR = HORS;
    const refus = await submitDocumentRequest(fd({ id: bc }));
    expect(refus.ok).toBe(false);
    ACTOR = INTERIM;
    const r = await submitDocumentRequest(fd({ id: bc, note: "Déposé pendant son congé" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: bc }, select: { status: true } })).status).toBe("SUBMITTED");
  });

  it("RÉAFFECTER : qui a demandé le BC le confie à une autre assistante active ; un tiers, une non-assistante, un BC déposé sont refusés", async () => {
    const bc = await demandeBC();
    ACTOR = HORS;
    const tiers = await reaffecterDemandeBC(fd({ id: bc, assistantId: da2Id }));
    expect(tiers.ok === false && tiers.error).toBe("La demande change d'assistante par qui l'a faite, par l'assistante sollicitée ou par la Direction.");

    ACTOR = PM;
    const pasAssistante = await reaffecterDemandeBC(fd({ id: bc, assistantId: horsId }));
    expect(pasAssistante.ok === false && pasAssistante.error).toBe("Cette personne n'est pas une assistante de direction active.");
    const r = await reaffecterDemandeBC(fd({ id: bc, assistantId: da2Id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: bc }, select: { askedToId: true } })).askedToId).toBe(da2Id);
    // La nouvelle assistante (par son rôle secondaire) est prévenue, sur le fil de la pièce — qu'elle ouvre.
    const avis = await prisma.notification.findFirst({ where: { userId: da2Id, title: "Bon de commande à établir" }, select: { link: true } });
    expect(avis?.link).toBe(`/pieces/${bc}`);
    expect(await canAccessEntity(DA2, "DOCUMENT_REQUEST", bc, "UPLOAD")).toBe(true);

    // L'intérimaire de l'ANCIENNE assistante n'a plus rien à y faire : la demande n'est plus la sienne.
    const relue = await prisma.documentRequest.findUniqueOrThrow({ where: { id: bc } });
    expect(await tientPourLaSollicitee(interimId, relue)).toBe(false);

    // Un BC déposé se vérifie : il ne change plus d'assistante.
    await prisma.documentRequest.update({ where: { id: bc }, data: { status: "SUBMITTED" } });
    const depose = await reaffecterDemandeBC(fd({ id: bc, assistantId: daId }));
    expect(depose.ok === false && depose.error).toBe("Le bon de commande est déposé : il se vérifie, il ne change plus d'assistante.");
  });

  it("RÉAFFECTER par l'intérimaire de l'assistante sollicitée : permis", async () => {
    const bc = await demandeBC();
    ACTOR = INTERIM;
    const r = await reaffecterDemandeBC(fd({ id: bc, assistantId: da2Id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });
});
