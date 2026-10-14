import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { recordStockSnapshot, requestStockState } from "./stock-snapshot-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__stockguard__";

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
 * ═══════════════════════════════════════════════════════════
 * LE PÉRIMÈTRE DE STOCK TIENT DANS L'ACTION, pas dans l'onglet.
 *
 * Un délégué médical relève les stocks des hôpitaux qu'il VISITE — depuis §118.134, ceux de SON
 * secteur, pour les produits de SA BU. La centrale d'achat (PCH) et ses annexes relèvent de la
 * chaîne d'approvisionnement — ce n'est pas son métier, et il y avait accès. Masquer les onglets
 * n'aurait rien fermé : la portée voyage dans un champ de formulaire, et une requête forgée écrit
 * aussi bien qu'un clic.
 * ═══════════════════════════════════════════════════════════
 */
suite("Périmètre des stocks", () => {
  let kamId = "", opsId = "", productId = "", produitAutreBuId = "";
  let etabSecteurId = "", etabAilleursId = "";

  beforeAll(async () => {
    const [kam, ops] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}kam`, email: `${TAG}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}ops`, email: `${TAG}ops@t.dz`, role: "OPERATIONS_DIRECTOR", passwordHash: "x" } }),
    ]);
    kamId = kam.id; opsId = ops.id;
    // Le KAM a le module STOCKS par la MATRICE (§118.185 — audit 360°, I5). Le banc le lui donnait
    // à la main (`userAccess` posé ici), et c'est ce qui cachait qu'aucun KAM réel ne pouvait relever
    // un stock : le cas passait, le produit refusait. Rien n'est plus posé à la main.
    const [produit, autre] = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-PRD`, dci: `${TAG} Amlodipine`, brandName: `${TAG} Cardiomax` } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-PRD-2`, dci: `${TAG} Nivolumab`, brandName: `${TAG} Nivolex` } }),
    ]);
    productId = produit.id; produitAutreBuId = autre.id;

    // SA BU, SON SECTEUR, SON HÔPITAL (§118.134) : le KAM a une fiche dans la BU, le secteur porte
    // un établissement de l'annuaire, et la BU promeut le produit Cardiomax — pas Nivolex.
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG} BU Cardio` } });
    await prisma.salesRepProfile.create({ data: { repId: kamId, businessUnitId: bu.id } });
    await prisma.promoProduct.create({ data: { name: `${TAG} Cardiomax`, businessUnitId: bu.id, regulatoryProductId: productId } });
    const [etab, ailleurs] = await Promise.all([
      prisma.medicalInstitution.create({ data: { name: `${TAG} CHU`, wilaya: "Alger" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG} EPH Ailleurs`, wilaya: "Oran" } }),
    ]);
    etabSecteurId = etab.id; etabAilleursId = ailleurs.id;
    await prisma.salesSector.create({
      data: {
        name: `${TAG} Centre`, businessUnitId: bu.id,
        institutions: { create: [{ institutionId: etab.id }] },
        reps: { create: [{ repId: kamId }] },
      },
    });
  });

  afterAll(async () => {
    await prisma.stockSnapshot.deleteMany({ where: { productId: { in: [productId, produitAutreBuId] } } }).catch(() => {});
    await prisma.stockAnnex.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesSector.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: kamId } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [kamId, opsId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("LE KAM RELÈVE LES HÔPITAUX DE SON SECTEUR — le premier relevé crée le lieu, rattaché à l'établissement", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const r = await recordStockSnapshot(form({
      scope: "HOSPITAL", institutionId: etabSecteurId, productId, date: "2031-05-04", quantity: "42",
    }));
    expect(r.ok, r.error).toBe(true);
    const lieu = await prisma.stockAnnex.findUnique({ where: { institutionId: etabSecteurId }, select: { id: true, name: true, kind: true } });
    expect(lieu?.kind).toBe("HOSPITAL");
    expect(lieu?.name).toBe(`${TAG} CHU`);
    expect(await prisma.stockSnapshot.count({ where: { productId, annexId: lieu?.id } })).toBe(1);
  });

  it("mais PAS un hôpital hors de son secteur, ni un produit hors de sa BU — même en forgeant la requête", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const horsSecteur = await recordStockSnapshot(form({
      scope: "HOSPITAL", institutionId: etabAilleursId, productId, date: "2031-05-04", quantity: "7",
    }));
    expect(horsSecteur.ok).toBe(false);
    expect(horsSecteur.error).toMatch(/secteur/i);
    expect(await prisma.stockAnnex.count({ where: { institutionId: etabAilleursId } })).toBe(0);

    const horsGamme = await recordStockSnapshot(form({
      scope: "HOSPITAL", institutionId: etabSecteurId, productId: produitAutreBuId, date: "2031-05-04", quantity: "7",
    }));
    expect(horsGamme.ok).toBe(false);
    expect(horsGamme.error).toMatch(/gamme/i);
    expect(await prisma.stockSnapshot.count({ where: { productId: produitAutreBuId } })).toBe(0);
  });

  it("mais il ne PEUT PAS écrire dans le stock PCH, même en forgeant la requête", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const r = await recordStockSnapshot(form({ scope: "PCH", productId, date: "2031-05-04", quantity: "9999" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/périmètre/i);
    expect(await prisma.stockSnapshot.count({ where: { productId, scope: "PCH" } })).toBe(0);
  });

  it("ni dans une ANNEXE PCH", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const annexe = await prisma.stockAnnex.create({ data: { name: `${TAG} Annexe`, kind: "ANNEX" } });
    const r = await recordStockSnapshot(form({
      scope: "ANNEX", annexId: annexe.id, productId, date: "2031-05-04", quantity: "500",
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/périmètre/i);
    await prisma.stockAnnex.delete({ where: { id: annexe.id } }).catch(() => {});
  });

  it("ni DEMANDER un état de stock — c'est une réquisition adressée à quelqu'un", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const r = await requestStockState(form({ targetUserId: opsId, dueDate: "2031-06-01" }));
    expect(r.ok).toBe(false);
  });

  it("LA CHAÎNE D'APPROVISIONNEMENT, elle, écrit dans le stock PCH — et dans n'importe quel hôpital de l'annuaire", async () => {
    // La règle ne vise pas une personne : elle lit l'accès au module PCH. Le directeur des
    // opérations l'a, donc il passe — sans qu'aucun rôle soit nommé dans le code.
    ACTOR = await actorFor(opsId, "OPERATIONS_DIRECTOR");
    const r = await recordStockSnapshot(form({ scope: "PCH", productId, date: "2031-05-05", quantity: "1200" }));
    expect(r.ok, r.error).toBe(true);
    const hopital = await recordStockSnapshot(form({
      scope: "HOSPITAL", institutionId: etabAilleursId, productId: produitAutreBuId, date: "2031-05-05", quantity: "12",
    }));
    expect(hopital.ok, hopital.error).toBe(true);
  });
});
