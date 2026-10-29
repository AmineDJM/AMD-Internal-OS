import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { dossiersPromoAMonTour } from "./promo-circuit";
import { getActionCenter } from "./action-center";
import { getAdProRequests } from "@/modules/ad-pro/api";
import { libelleEtape } from "@/lib/promo-material/circuit";
import { createPromoMaterial } from "@/lib/actions/promo-material-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__promotour__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE D'ACTIONS DANS LA PEAU DES GENS (§118.153) — par les VRAIS points d'entrée.
 *
 * Le centre d'actions nourrit l'accueil (« Validations à faire »), la boîte de décisions et tout
 * ce qui en dérive. Il lisait le statut HÉRITÉ des dossiers de matériel promotionnel — figé à
 * « Prospection demandée » pour tout le circuit : chacun y voyait le mauvais dossier, au mauvais
 * moment, avec le mauvais libellé. Et la liste unifiée Ad & Pro ne bornait pas ces dossiers au
 * périmètre de la personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("chacun voit SON tour, avec le vrai libellé", () => {
  const u: Record<string, string> = {};
  const d: Record<string, string> = {};
  let companyId = "", article = "";

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("ns", "NATIONAL_SALES");
    await mk("dg", "GENERAL_MANAGER");
    await mk("asst", "DIRECTION_ASSISTANT");
    await mk("sa", "SUPER_ADMIN");
    await mk("dm", "PRODUCT_MANAGER");
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } })).id;
    const ns = await prisma.employee.create({ data: { fullName: `${TAG} ns`, userId: u.ns, companyId } });
    await prisma.employee.create({ data: { fullName: `${TAG} kam`, userId: u.kam, managerId: ns.id, companyId } });
    const dossier = async (k: string, circuitState: string, requester: string, extra: Record<string, unknown> = {}) => {
      d[k] = (await prisma.promoMaterial.create({
        data: {
          reference: `${TAG}-${k}`, title: `${TAG} ${k}`, status: "PROSPECTION_REQUESTED", circuitState: circuitState as never, circuitVersion: 2,
          requesterId: u[requester], createdById: u[requester], updatedById: u[requester], companyId, ...extra,
        },
      })).id;
    };
    await dossier("req", "REVIEW_REQUEST", "kam", { requestValidation: true, requestValidatorId: u.ns });
    await dossier("devis", "QUOTE_REQUESTED", "kam");
    await dossier("dg", "REVIEW_DG", "dm");
    await dossier("exec", "IN_EXECUTION", "kam");
    // Une demande naît avec ses lignes (§118.171) : l'article que le KAM demandera.
    article = (await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}ART`, nom: `${TAG} Carnet bilan`, famille: "CONSOMMABLE" } })).id;
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    await prisma.promoMaterial.deleteMany({ where: { title: { startsWith: TAG } } });
    // Les lignes sont parties avec leur dossier (Cascade) : l'article ne les retient plus.
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG }, managerId: { not: null } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
  }

  const idsDe = async (k: string, role: SessionUser["role"]) =>
    (await dossiersPromoAMonTour(await acteur(u[k], role))).filter((x) => Object.values(d).includes(x.id));

  it("le N+1 voit la demande de son KAM — et elle seule", async () => {
    const t = await idsDe("ns", "NATIONAL_SALES");
    expect(t.map((x) => [x.id, x.tour])).toEqual([[d.req, "VALIDATION"]]);
  });

  it("l'assistante voit les devis à retranscrire", async () => {
    const t = await idsDe("asst", "DIRECTION_ASSISTANT");
    expect(t.map((x) => [x.id, x.tour])).toEqual([[d.devis, "GESTE"]]);
  });

  it("le DG voit l'étape qui l'attend, avec son VRAI libellé — et plus le dossier en exécution", async () => {
    const dg = await acteur(u.dg, "GENERAL_MANAGER");
    const { items } = await getActionCenter(dg);
    const promo = items.filter((i) => i.href?.startsWith("/promo-material/"));
    expect(promo.map((i) => i.href)).toContain(`/promo-material/${d.dg}`);
    expect(promo.map((i) => i.href)).not.toContain(`/promo-material/${d.exec}`);
    expect(promo.find((i) => i.href === `/promo-material/${d.dg}`)?.statusLabel).toBe(libelleEtape("REVIEW_DG", 2));
  });

  it("le Super Admin PEUT tout débloquer, mais n'est pas inondé des tours des autres", async () => {
    expect(await idsDe("sa", "SUPER_ADMIN")).toEqual([]);
  });

  it("la liste unifiée Ad & Pro borne le matériel promotionnel au périmètre de la personne", async () => {
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    const vus = (await getAdProRequests(kam)).map((r) => r.id);
    expect(vus).toEqual(expect.arrayContaining([d.req, d.devis, d.exec]));
    expect(vus, "le dossier d'une autre personne n'est pas dans SA liste").not.toContain(d.dg);
    // Et l'état unifié lit le circuit : un dossier en exécution est « validé », pas « en attente ».
    const exec = (await getAdProRequests(kam)).find((r) => r.id === d.exec);
    expect(exec?.state).toBe("APPROVED");
  });

  it("le KAM DEMANDE du matériel promotionnel sans accès posé à la main — et la société est la sienne", async () => {
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    // PRÉMISSE : c'est la MATRICE qui le lui donne, et le périmètre reste le sien.
    expect(userCan(kam, "PROMO_MATERIAL", "CREATE")).toBe(true);
    expect(kam.access.modules.get("PROMO_MATERIAL")?.scope).toBe("ASSIGNED");
    ACTOR = kam;
    const fd = new FormData();
    fd.set("title", `${TAG} Carnets bilan`);
    fd.set("description", "Carnets pour la tournée d'octobre");
    fd.set("lignes", JSON.stringify([{ catalogueId: article, quantite: "300", actions: ["IMPRESSION"], produitIds: [], commentaire: "" }]));
    const r = await createPromoMaterial(undefined, fd);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const cree = await prisma.promoMaterial.findFirstOrThrow({ where: { title: `${TAG} Carnets bilan` } });
    // La société est celle qui emploie le demandeur — le formulaire ne la demande plus (§118.171) ;
    // sans elle le dossier naissait sans société, et `platformScope` le cachait à son propre auteur.
    expect(cree.companyId).toBe(companyId);
    expect((await getAdProRequests(kam)).map((x) => x.id)).toContain(cree.id);
  });
});
