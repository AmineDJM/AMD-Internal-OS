import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { EVENEMENT_CREATION } from "@/lib/agent/operations/adpro-evenement";
import { MATERIEL_PROMO_CREATION } from "@/lib/agent/operations/adpro-materiel-promo";
import { AUTRE_CREATION, POSTE_AJOUT } from "@/lib/agent/operations/adpro-poste-autre";
import { trouverDemande } from "@/lib/agent/operations/demandes-visibles";
import { executerOperationIA } from "@/lib/agent/operations";

/**
 * L'ASSISTANT IA — ÉVÉNEMENT, MATÉRIEL PROMOTIONNEL, DEMANDE « AUTRE », POSTE DE COÛT, par les
 * actions de l'écran ; et la demande visée n'est cherchée QUE parmi celles que la personne voit.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaadp_${Date.now().toString(36)}_`;
let admin: CurrentUser;
let collegue: CurrentUser;
let articleId = "";
let spoId = "";

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

suite("Assistant IA — les autres natures Ad & Pro", () => {
  beforeAll(async () => {
    admin = await compte("admin", "SUPER_ADMIN");
    collegue = await compte("delegue", "MEDICAL_DELEGATE");
    articleId = (await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}KAK-01`, nom: `${TAG}Kakémono`, famille: "DURABLE", exigeProduit: false, actif: true } })).id;
    spoId = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}Société de pneumologie`, type: "Congrès", requesterId: admin.id, createdById: admin.id, status: "AWAITING_PRELIMINARY" } })).id;
  });

  afterAll(async () => {
    const ev = await prisma.event.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ev.map((e) => e.id) } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const pm = await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.promoRequestItem.deleteMany({ where: { promoMaterialId: { in: pm.map((p) => p.id) } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { id: articleId } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: admin?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("événement : créé ET soumis au circuit en une confirmation", async () => {
    const p = await EVENEMENT_CREATION.proposer({
      nom: `${TAG}Journée du souffle`, type: "journée scientifique", portee: "national", format: "présentiel",
      debut: "2026-12-03", fin: "2026-12-03", lieu: "Hôtel Sheraton", ville: "Alger", pays: "Algérie", specialite: "Pneumologie",
      medecins: "Dr Hors Annuaire", produits: "Respirol", budgetEstime: 800_000, responsable: "moi", description: "Journée de formation.",
    }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = admin;
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: EVENEMENT_CREATION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const ev = await prisma.event.findFirstOrThrow({ where: { name: `${TAG}Journée du souffle` } });
    expect(ev.requestStatus).not.toBeNull();
  });

  it("matériel promotionnel : l'article se cherche au catalogue ; la ligne sans action est demandée", async () => {
    const incomplet = await MATERIEL_PROMO_CREATION.proposer({ titre: `${TAG}Campagne hiver`, articles: [{ article: `${TAG}Kakémono`, quantite: "4" }] }, admin);
    expect("manque" in incomplet && incomplet.manque[0]).toMatch(/ce qu'on attend du fournisseur/);
    const p = await MATERIEL_PROMO_CREATION.proposer({ titre: `${TAG}Campagne hiver`, articles: [{ article: `${TAG}KAK-01`, quantite: "4", actions: ["conception", "impression"] }] }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = admin;
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: MATERIEL_PROMO_CREATION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.promoMaterial.count({ where: { title: `${TAG}Campagne hiver` } })).toBe(1);
  });

  it("demande « autre » : objet + description, part à la Direction", async () => {
    const p = await AUTRE_CREATION.proposer({ objet: `${TAG}Abonnement revue`, description: "Abonnement annuel à une revue médicale.", montant: 120_000 }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = admin;
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: AUTRE_CREATION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
  });

  it("poste : la demande se trouve par sa référence ; la carte nomme la demande et la nature", async () => {
    const p = await POSTE_AJOUT.proposer({ demande: `${TAG}SPO-1`, libelle: "Stand 9 m²", naturePoste: "stand", montant: 300_000 }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.fields.find((f) => f.label === "Poste")?.value).toBe("Stand 9 m² (Stand)");
    expect(p.args.parentId).toBe(spoId);
  });

  it("LIMITE : une demande d'un autre n'est ni trouvée ni NOMMÉE à qui ne la voit pas", async () => {
    const r = await trouverDemande(collegue, `${TAG}SPO-1`, "sponsoring");
    expect("manque" in r && r.manque).toMatch(/aucune demande que vous pouvez voir/);
    expect(JSON.stringify(r)).not.toContain("pneumologie");
  });
});
