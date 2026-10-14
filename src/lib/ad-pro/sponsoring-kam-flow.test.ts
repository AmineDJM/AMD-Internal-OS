import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, moduleScope, userCan, type SessionUser } from "@/lib/rbac";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import { updateAdProItem } from "@/lib/actions/ad-pro-item-actions";
import { canAccessEntity } from "@/lib/entity-access";
import { clauseSponsoringsVisibles } from "@/lib/queries/visibilite-listes";
import { getAdProRequests } from "@/lib/queries/ad-pro";
import { ensureInstance } from "@/lib/workflow/engine";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SPONSORING D'UN KAM — qu'il puisse le déposer, et lui seul le voir (§118.185 — audit 360°, I4).
 *
 * La décision du 28/09 fait passer « le sponsoring d'un KAM » par le National Sales puis la
 * Direction des opérations (§118.156) ; le rôle n'avait pas le module, donc la règle était écrite
 * pour une demande que personne ne pouvait déposer. Lui ouvrir le module sans portée par ligne
 * lui aurait ouvert, du même geste, les demandes de tous ses collègues : le sponsoring n'avait
 * aucune portée, parce qu'aucun de ses porteurs n'en avait besoin.
 *
 * Joué par les vraies portes, avec deux KAM de la MÊME société (l'entité ne peut donc pas les
 * séparer : seule la portée par ligne le peut) et un National Sales, qui voit tout.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__spokam${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

function formulaire(institution: string): FormData {
  const f = new FormData();
  f.set("institution", institution);
  f.append("doctorIds", `${TAG}Dr Benali`);
  f.append("productIds", `${TAG}Nivolex`);
  f.set("city", "Alger");
  f.set("specialty", "Cardiologie");
  f.set("type", "Congrès");
  f.set("amountRequested", "120000");
  f.set("amountProposed", "90000");
  f.set("nature", "DIRECT");
  f.set("strategicImportance", "HIGH");
  f.append("files", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "demande.pdf", { type: "application/pdf" }));
  return f;
}

suite("le sponsoring d'un KAM : il le dépose, il est seul à le voir, le National Sales l'instruit", () => {
  const ids: Record<string, string> = {};
  let buId = "", companyId = "", spoId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__spokam" } }, select: { id: true } })).map((u) => u.id);
    const spos = (await prisma.sponsoringRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true } })).map((s) => s.id);
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: spos } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityType: "SPONSORING", entityId: { in: spos } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityType: "SPONSORING", entityId: { in: spos } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: comptes } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: "__spokam" } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const c = await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } });
    companyId = c!.id;
    buId = (await prisma.businessUnit.create({ data: { name: `${TAG} BU` }, select: { id: true } })).id;
    for (const [cle, role] of [["kam1", "MEDICAL_DELEGATE"], ["kam2", "MEDICAL_DELEGATE"], ["ns", "NATIONAL_SALES"]] as const) {
      const u = await prisma.user.create({ data: { name: `${TAG} ${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
      await prisma.employee.create({ data: { fullName: `${TAG} ${cle}`, userId: u.id, isActive: true, companyId } });
      ids[cle] = u.id;
    }
    await prisma.salesRepProfile.createMany({ data: [{ repId: ids.kam1, businessUnitId: buId }, { repId: ids.kam2, businessUnitId: buId }] });
  }, 120_000);
  afterAll(nettoyer, 120_000);

  it("PRÉMISSES : le KAM a le module pour DEMANDER, sans vue globale ; le National Sales voit tout", async () => {
    const kam = await actorFor(ids.kam1, "MEDICAL_DELEGATE");
    expect(userCan(kam, "SPONSORING", "CREATE")).toBe(true);
    expect(userCan(kam, "SPONSORING", "VALIDATE"), "il demande, il ne tranche rien").toBe(false);
    expect(moduleScope(kam, "SPONSORING"), "sans portée par ligne, le cloisonnement ne serait pas éprouvé").toBe("ASSIGNED");
    expect(moduleScope(await actorFor(ids.ns, "NATIONAL_SALES"), "SPONSORING")).toBe("ALL");
    // Aucun accès posé à la main : c'est la MATRICE qui l'ouvre.
    expect(await prisma.userAccess.count({ where: { userId: { in: [ids.kam1, ids.kam2] } } })).toBe(0);
  });

  it("LE KAM DÉPOSE SON SPONSORING — sur SA gamme, et le circuit commence au National Sales", async () => {
    ACTOR = await actorFor(ids.kam1, "MEDICAL_DELEGATE");
    const r = await createSponsoring(undefined, formulaire(`${TAG} Association cardio`));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    spoId = r.ok ? r.id! : "";
    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId }, select: { requesterId: true, businessUnitId: true } });
    expect(spo).toEqual({ requesterId: ids.kam1, businessUnitId: buId });
    // Le circuit naît à la première lecture (la fiche l'ouvre) : la même porte que l'écran.
    const inst = await ensureInstance("SPONSORING", spoId);
    expect(inst?.currentSlug, "un KAM entre par son National Sales (§118.156)").toBe("preliminary");
  });

  it("IL VOIT SA DEMANDE partout où elle se lit : la liste, la fiche, « Toutes les demandes »", async () => {
    const kam = await actorFor(ids.kam1, "MEDICAL_DELEGATE");
    expect(await prisma.sponsoringRequest.count({ where: { AND: [{ id: spoId }, await clauseSponsoringsVisibles(kam)] } })).toBe(1);
    expect(await canAccessEntity(kam, "SPONSORING", spoId, "VIEW")).toBe(true);
    expect((await getAdProRequests(kam)).some((d) => d.id === spoId)).toBe(true);
  });

  it("UN COLLÈGUE DE LA MÊME SOCIÉTÉ ne la voit NULLE PART — ni la liste, ni la fiche, ni ses postes", async () => {
    const autre = await actorFor(ids.kam2, "MEDICAL_DELEGATE");
    expect(await prisma.sponsoringRequest.count({ where: { AND: [{ id: spoId }, await clauseSponsoringsVisibles(autre)] } })).toBe(0);
    expect(await canAccessEntity(autre, "SPONSORING", spoId, "VIEW")).toBe(false);
    expect((await getAdProRequests(autre)).some((d) => d.id === spoId)).toBe(false);
    // Le poste créé avec la demande : un identifiant deviné ne doit rien ouvrir.
    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spoId }, select: { id: true } });
    ACTOR = autre;
    const r = await updateAdProItem(undefined, (() => { const f = new FormData(); f.set("id", poste.id); f.set("label", "détourné"); return f; })());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/introuvable/);
  });

  it("LE NATIONAL SALES la voit et l'instruit — portée entière", async () => {
    const ns = await actorFor(ids.ns, "NATIONAL_SALES");
    expect(await prisma.sponsoringRequest.count({ where: { AND: [{ id: spoId }, await clauseSponsoringsVisibles(ns)] } })).toBe(1);
    expect(await canAccessEntity(ns, "SPONSORING", spoId, "VIEW")).toBe(true);
  });

  it("LE RELEVÉ DES STOCKS HOSPITALIERS est ouvert au KAM et au National Sales par la matrice (I5)", async () => {
    // L'écran des stocks a été conçu pour eux (§118.134) ; la portée (secteur, BU) se calcule sur les
    // faits, et le banc des stocks éprouve qu'elle ne montre rien d'autre.
    for (const [cle, role] of [["kam1", "MEDICAL_DELEGATE"], ["ns", "NATIONAL_SALES"]] as const) {
      const a = await actorFor(ids[cle], role);
      expect(userCan(a, "STOCKS", "VIEW"), `${role} voit les stocks`).toBe(true);
      expect(userCan(a, "STOCKS", "CREATE"), `${role} relève un stock`).toBe(true);
      expect(userCan(a, "STOCKS", "DELETE"), `${role} ne supprime pas les relevés des autres`).toBe(false);
      expect(userCan(a, "PCH", "VIEW"), `prémisse : ${role} ne tient pas la chaîne d'approvisionnement`).toBe(false);
    }
  });
});
