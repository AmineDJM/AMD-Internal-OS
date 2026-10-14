import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { saveAssignment, deleteAssignment } from "./sales-planning-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__sfetest__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AFFECTER UN PRODUIT À UN KAM — et le RETROUVER.
 *
 * Le défaut rapporté : « on ne voit pas le produit quand on l'ajoute au KAM ». La cause n'était
 * pas un affichage : l'action SUPPRIMAIT la ligne qu'on venait de créer. Elle traitait « zéro
 * visite et pas de note » comme un ordre de nettoyage — or c'est exactement l'état d'une
 * affectation qu'on vient d'ajouter et dont on n'a pas encore saisi les visites. Elle répondait
 * « ok », et rien ne s'affichait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Affectation produit → KAM", () => {
  let adminId = "", repId = "", productId = "", cycleId = "";

  beforeAll(async () => {
    const [admin, rep] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}kam`, email: `${TAG}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
    ]);
    adminId = admin.id; repId = rep.id;
    const produit = await prisma.promoProduct.create({ data: { name: `${TAG} Cardiomax`, isActive: true } });
    productId = produit.id;
    const cycle = await prisma.promoCycle.create({ data: { year: 2031, month: 7, label: `${TAG} juillet 2031` } });
    cycleId = cycle.id;
  });

  afterAll(async () => {
    await prisma.promotionAssignment.deleteMany({ where: { cycleId } }).catch(() => {});
    await prisma.promoCycle.deleteMany({ where: { id: cycleId } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("UN PRODUIT AJOUTÉ SANS VISITES EXISTE — c'est l'état normal d'une ligne qu'on vient de créer", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await saveAssignment(form({ cycleId, repId, productId, position: "1", plannedVisits: "0" }));
    expect(r.ok).toBe(true);

    const ligne = await prisma.promotionAssignment.findFirst({ where: { cycleId, repId, productId } });
    expect(ligne, "l'affectation a été supprimée à l'enregistrement").not.toBeNull();
    expect(ligne?.plannedVisits).toBe(0);
    expect(ligne?.position).toBe(1);
  });

  it("remettre les visites à zéro ne la fait pas disparaître non plus", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    await saveAssignment(form({ cycleId, repId, productId, position: "2", plannedVisits: "12" }));
    expect((await prisma.promotionAssignment.findFirst({ where: { cycleId, repId, productId } }))?.plannedVisits).toBe(12);

    // On efface le champ : la ligne RESTE, avec son rang. Vider un champ n'est pas supprimer une
    // affectation — pour cela il y a un bouton qui ne fait que ça.
    await saveAssignment(form({ cycleId, repId, productId, position: "2", plannedVisits: "0" }));
    const ligne = await prisma.promotionAssignment.findFirst({ where: { cycleId, repId, productId } });
    expect(ligne).not.toBeNull();
    expect(ligne?.position).toBe(2);
  });

  it("le RETRAIT reste un geste explicite, et lui seul supprime", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await deleteAssignment(form({ cycleId, repId, productId }));
    expect(r.ok).toBe(true);
    expect(await prisma.promotionAssignment.findFirst({ where: { cycleId, repId, productId } })).toBeNull();
  });
});
