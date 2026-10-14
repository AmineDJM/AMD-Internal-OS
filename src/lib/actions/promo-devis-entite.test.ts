import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { platformScope } from "@/lib/company";
import { getRequestList } from "@/lib/queries/admin-requests";
import { demanderDevisPromo } from "./promo-devis-actions";
import { enregistrerArticleDemandePromo } from "./promo-demande-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__devisentite__";

/** Les droits viennent de la VRAIE matrice de rôles : un droit posé à la main prouverait une porte
 *  qu'aucun rôle réel ne franchit. */
async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.set(k, v);
  }
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE DE DEVIS D'UN DOSSIER NÉ SANS SOCIÉTÉ ARRIVE DANS LE BUREAU DE L'ASSISTANTE (§118.154).
 *
 * Mesuré dans la peau de l'assistante de direction : un dossier créé avant que la création porte
 * son entité a `companyId` nul, et sa demande au secrétariat héritait de ce nul. Une ligne sans
 * société n'apparaît dans AUCUNE vue cloisonnée (`platformScopeWhere`) : l'assistante était
 * prévenue, le dossier affichait « devis demandés », et son bureau ne montrait rien — une étape que
 * personne ne pouvait faire avancer, sans une ligne d'échec. La demande prend désormais la société
 * où TRAVAILLE le demandeur (`moneyEntityOf`).
 *
 * L'assistante est une lectrice SANS vue globale : une portée éprouvée avec un Super Admin ne peut
 * pas tomber (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("demanderDevisPromo — la société d'une demande de devis", () => {
  const u: Record<string, string> = {};
  let societeC = "", societeD = "";
  let dossierSansSociete = "", dossierDeD = "", dossierSuppleance = "";

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("asst", "DIRECTION_ASSISTANT");
    await mk("dir", "DIRECTION");
    societeC = (await prisma.company.create({ data: { name: `${TAG} C`, shortName: `${TAG}C`.slice(0, 12), color: "#1B7F79" } })).id;
    societeD = (await prisma.company.create({ data: { name: `${TAG} D`, shortName: `${TAG}D`.slice(0, 12), color: "#7F1B1B" } })).id;
    // Les deux personnes TRAVAILLENT pour C : c'est ce qui leur ouvre C, et rien d'autre.
    await prisma.employee.create({ data: { fullName: `${TAG} kam`, userId: u.kam, companyId: societeC } });
    await prisma.employee.create({ data: { fullName: `${TAG} asst`, userId: u.asst, companyId: societeC } });
    // La Direction, elle, travaille pour D : c'est ce qui distingue la société du DEMANDEUR de celle
    // de la personne qui clique (§118.111 — sans ce décor, les deux lectures donneraient C).
    await prisma.employee.create({ data: { fullName: `${TAG} dir`, userId: u.dir, companyId: societeD } });
    const dossier = async (suffixe: string, companyId: string | null) => (await prisma.promoMaterial.create({
      data: {
        reference: `${TAG}-${suffixe}`, title: `${TAG} Carnets ${suffixe}`, status: "PROSPECTION_REQUESTED",
        circuitState: "QUOTE_TO_REQUEST", circuitVersion: 2, companyId,
        requesterId: u.kam, assistantId: u.asst, createdById: u.kam, updatedById: u.kam,
      },
    })).id;
    dossierSansSociete = await dossier("NUL", null);
    dossierDeD = await dossier("D", societeD);
    dossierSuppleance = await dossier("SUPPL", null);
    // LES ARTICLES D'ABORD (§118.165) : une demande de devis sans liste d'articles est refusée — la
    // liste dit à l'assistante quels devis chercher. Composée par le DEMANDEUR, par la vraie action
    // de l'écran : un article inséré à la main prouverait un dossier que personne ne compose ainsi.
    const carnet = (await prisma.promoCatalogueArticle.create({
      data: { reference: `${TAG}CAT`, nom: `${TAG} Carnet`, famille: "CONSOMMABLE" }, select: { id: true },
    })).id;
    ACTOR = await acteur(u.kam);
    for (const pmId of [dossierSansSociete, dossierDeD, dossierSuppleance]) {
      const a = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: carnet, quantite: "200", actions: ["IMPRESSION"] }));
      expect(a.ok, a.ok ? "" : a.error).toBe(true);
    }
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    const dossiers = (await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    await prisma.promoMaterial.updateMany({ where: { id: { in: dossiers } }, data: { adminRequestId: null } }).catch(() => undefined);
    await prisma.administrativeRequest.deleteMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: dossiers } } });
    await prisma.administrativeRequest.deleteMany({ where: { title: { startsWith: TAG } } });
    // Les articles composés partent avec leur dossier (cascade) ; l'article du catalogue après eux.
    await prisma.promoMaterial.deleteMany({ where: { id: { in: dossiers } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  }

  it("PRÉMISSES : le bureau de l'assistante est cloisonné par société, et une ligne sans société n'y apparaît pas", async () => {
    // Sans elles, le cas principal pourrait passer au vert parce que la portée ne filtre RIEN (moins
    // de deux sociétés, ou une personne cloisonnée par rien) — et il ne garderait plus rien (§118.104).
    const portee = await platformScope(u.asst);
    expect(portee, "la portée de l'assistante filtre par société").toHaveProperty("companyId");
    const asst = await acteur(u.asst);
    const temoin = await prisma.administrativeRequest.create({
      data: { reference: `${TAG}-T`, type: "QUOTE", title: `${TAG} témoin sans société`, status: "NEW", assignedToId: u.asst, companyId: null },
      select: { id: true },
    });
    const liste = (await getRequestList(asst, {})).rows;
    expect(liste.map((r) => r.id), "une demande sans société est invisible — c'est la raison du correctif").not.toContain(temoin.id);
  });

  it("un dossier SANS société : la demande prend la société où travaille le demandeur, et arrive au bureau", async () => {
    ACTOR = await acteur(u.kam);
    const r = await demanderDevisPromo(form({ promoMaterialId: dossierSansSociete }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: dossierSansSociete }, select: { adminRequestId: true, circuitState: true } });
    expect(pm.circuitState).toBe("QUOTE_REQUESTED");
    const demande = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: pm.adminRequestId! }, select: { id: true, companyId: true } });
    expect(demande.companyId, "la société du demandeur, jamais nulle").toBe(societeC);
    // Le point qui compte pour une personne : l'assistante la VOIT dans son bureau.
    const liste = (await getRequestList(await acteur(u.asst), {})).rows;
    expect(liste.map((x) => x.id)).toContain(demande.id);
  });

  it("un dossier AVEC société garde la sienne — le repli ne remplace jamais une société déclarée", async () => {
    // Le demandeur travaille pour C ; le dossier est à D. La demande suit le DOSSIER : une dépense
    // engagée pour D ne passe pas à C parce que son auteur y travaille.
    ACTOR = await acteur(u.kam);
    const r = await demanderDevisPromo(form({ promoMaterialId: dossierDeD }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: dossierDeD }, select: { adminRequestId: true } });
    const demande = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: pm.adminRequestId! }, select: { companyId: true } });
    expect(demande.companyId).toBe(societeD);
  });

  it("la Direction qui demande EN SUPPLÉANCE : la société est celle du DEMANDEUR, pas la sienne", async () => {
    // La Direction travaille pour D ; le demandeur du dossier pour C. Le devis engage une dépense
    // du DOSSIER du demandeur : l'imputer à la société de celui qui clique le ferait disparaître du
    // bureau de l'assistante de C, exactement le défaut qu'on ferme, par une autre porte.
    ACTOR = await acteur(u.dir);
    const r = await demanderDevisPromo(form({ promoMaterialId: dossierSuppleance }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: dossierSuppleance }, select: { adminRequestId: true } });
    const demande = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: pm.adminRequestId! }, select: { id: true, companyId: true, requesterId: true } });
    expect(demande.requesterId, "le demandeur reste celui du dossier").toBe(u.kam);
    expect(demande.companyId).toBe(societeC);
    expect((await getRequestList(await acteur(u.asst), {})).rows.map((x) => x.id)).toContain(demande.id);
  });
});
