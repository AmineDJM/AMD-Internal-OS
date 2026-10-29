import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

// ⚠ ORDRE D'IMPORT (documenté dans `assistant/capability-audit.test.ts`) : `ops/index.ts` et
// `lib/assistant.ts` forment un cycle d'INITIALISATION. `assistant` se charge le PREMIER, comme dans
// l'application — avant toute action qui, par la fabrique, remonterait le cycle par l'autre bout.
import { buildProposal, performAction } from "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { canAccessEntity } from "@/lib/entity-access";
import { canEditCompanyId, getMyCompanies } from "@/lib/company";
import { resolveDriveAccess, canViewDrive, canEditDrive } from "@/lib/drive";
import { createPromoMaterial, submitQuotes, cancelPromoMaterial } from "./promo-material-actions";
import { validatePromoStep, refusePromoStep, completePromoTrack } from "./promo-circuit-actions";
import {
  demanderDevisPromo, enregistrerDevisPromo, terminerRetranscriptionPromo, choisirLignesPromo, demanderCorrectionDevisPromo,
} from "./promo-devis-actions";
import {
  genererBonsDeCommandePromo, marquerBonDeCommandeEnvoye, deposerFacturePromo, demanderPaiementFacturePromo,
  annulerBonDeCommandePromo, receptionnerLigneFacturePromo, modifierBonDeCommandePromo, validerEtEnvoyerBcPromo,
} from "./promo-execution-actions";
import { enregistrerArticleDemandePromo, retirerArticleDemandePromo } from "./promo-demande-actions";
import { REFUS_SANS_LIGNE } from "@/lib/promo-material/lignes-demande";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";
import { signerBonDeCommande } from "./bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { etatCompletDuBC } from "@/lib/bons-de-commande/etat-bc-test-outils";
import { decidePayment } from "./payment-centre-actions";
import { validateursDeLaDemande, peutOuvrirLeDossierPromo } from "@/lib/queries/promo-circuit";
import { getAdProCreateData } from "@/modules/ad-pro/api";
import { executionDuDossier } from "@/lib/queries/promo-execution";
import { emettreDocumentDrive } from "@/platform/in-process/artifact/factory";
import { portsArtefact } from "@/platform/in-process/artifact/ports";
import { designerDossierPromo } from "@/platform/in-process/promo";
import { fichierEmisDeLaPiece, specDeLaPieceEmise } from "@/lib/queries/legal-fichier";
import { construireXlsxCommercial } from "@/lib/artifact/factory/xlsx";
import { calculerTotaux, type SpecDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { fichiersEmis } from "@/lib/legal/fichiers-emis";
import { etatDuBC } from "@/lib/bons-de-commande/etat";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__promov2__${Date.now().toString(36)}`;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
  }
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], nom, { type: "application/pdf" });
const etatDe = (id: string) => prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true, circuitVersion: true, chosenAmount: true, chosenAgency: true, status: true, tracksDone: true } });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CIRCUIT DU MATÉRIEL PROMOTIONNEL PAR DEVIS RETRANSCRITS — par les VRAIS points d'entrée (§118.152).
 *
 * Le parcours entier d'un membre de la Direction Marketing : sa directrice valide la demande, il
 * demande les devis, l'assistante les retranscrit ligne à ligne, il retient des lignes de DEUX
 * devis, sa directrice valide le devis, le DG au-dessus du seuil, puis deux BC générés par la
 * plateforme (un par fournisseur), validés au centre Ad & Pro, signés par les Finances, une
 * facture par BC (fichier obligatoire), le paiement au centre de paiement, et la demande de visa
 * qui part avec chaque paiement. Les chantiers se CONSTATENT sur les pièces.
 *
 * Les acteurs n'ont pas de vue globale (§118.104) — sauf ceux dont c'est le rôle d'arbitrer. Le
 * N+1 d'un délégué, qui n'a PAS le module, ouvre la fiche qu'on lui demande de valider.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — circuit 2 de bout en bout", () => {
  const u: Record<string, string> = {};
  let companyId = "", fourA = "", fourB = "", pmId = "", kamPmId = "", catPresentoir = "", catStand = "", catCarnet = "";
  // Ce que les cas de création FORGENT ou choisissent : des lignes À CE BANC (§118.102a). Lire « le
  // premier produit actif » de la base partagée a fait citer, par une ligne demandée, le produit
  // qu'un banc voisin venait de créer — et son nettoyage a échoué sur la clé étrangère.
  let produitBanc = "", buBanc = "", autreSociete = "";
  const emp: Record<string, string> = {};
  let seuilDg = 0;

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("ops", "DIRECTION");
    await mk("dir", "PRODUCT_MANAGER");
    await mk("cp", "MEDICAL_PROMOTION_MANAGER");
    await mk("asst", "DIRECTION_ASSISTANT");
    await mk("dg", "GENERAL_MANAGER");
    await mk("fin", "FINANCE_BUDGET_MANAGER");
    await mk("pharma", "MEDICAL_INFO_PHARMACIST");
    await mk("ns", "NATIONAL_SALES");
    await mk("ns2", "NATIONAL_SALES");
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("dehors", "SALES_USER");
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } });
    companyId = c.id;
    // L'ORGANIGRAMME — la chaîne canonique : chef de produit → directrice marketing → Direction
    // des opérations ; délégué → superviseur national → Direction des opérations. Tous SALARIÉS de
    // la société : c'est ce qui leur en ouvre la LECTURE, et rien de plus — aucun n'a le droit
    // nominatif de l'ENGAGER (`UserCompanyAccess.canEdit`), comme dans la vraie vie.
    const e = async (k: string, managerKey: string | null) => {
      emp[k] = (await prisma.employee.create({
        data: { fullName: `${TAG} ${k}`, userId: u[k], managerId: managerKey ? emp[managerKey] : null, companyId },
      })).id;
    };
    await e("ops", null);
    await e("dir", "ops");
    await e("cp", "dir");
    await e("ns", "ops");
    await e("kam", "ns");
    await e("asst", null);
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    seuilDg = (await getAppSettings()).adProDgThreshold ?? 0;
    // UNE VAGUE : ce que rien ne lie part ENSEMBLE (§118.102b) — fournisseurs, catalogue, produit,
    // gamme, seconde société. Écrites l'une après l'autre, ces huit lignes avaient fait passer ce
    // décor au-delà du plafond mesuré d'attentes séquentielles (`decors-de-test.test.ts`).
    // LE CATALOGUE (§118.165) — la demande s'y pioche : un présentoir (durable), un stand (durable,
    // reçu « en plus »), un carnet (consommable).
    const cat = (suffixe: string, nom: string, famille: "CONSOMMABLE" | "DURABLE") =>
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}-${suffixe}`, nom: `${TAG} ${nom}`, famille }, select: { id: true } });
    const vague = await Promise.all([
      prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Atlas`, address: "Zone industrielle", city: "Alger", rc: "16/00-111", nif: "0001", companyId: null }, select: { id: true } }),
      prisma.companyContact.create({ data: { name: `${TAG} Stands Sahel`, address: "Rue 5", city: "Oran", rc: "31/00-222", nif: "0002", companyId: null }, select: { id: true } }),
      cat("PLV", "Présentoir PLV", "DURABLE"),
      cat("STAND", "Stand modulaire", "DURABLE"),
      cat("CARNET", "Carnet bilan", "CONSOMMABLE"),
      prisma.product.create({
        data: { code: `${TAG}P1`, canonicalName: `${TAG} Nivolex`, dci: `${TAG}p1dci`, identityKey: `${TAG}P1` } as never,
        select: { id: true },
      }),
      prisma.businessUnit.create({ data: { name: `${TAG} Oncologie`, companyId }, select: { id: true } }),
      prisma.company.create({ data: { name: `${TAG} Autre`, shortName: `${TAG.slice(0, 10)}AU`, color: "#5B6B7A" }, select: { id: true } }),
    ]);
    [fourA, fourB, catPresentoir, catStand, catCarnet, produitBanc, buBanc, autreSociete] = vague.map((r) => r.id);
  }, 60_000);

  afterAll(async () => {
    const pms = (await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, adminRequestId: true } }));
    const pmIds = pms.map((p) => p.id);
    const pieces = (await prisma.legalDocument.findMany({ where: { OR: [{ companyId }, { sourceType: "PROMO_MATERIAL", sourceId: { in: pmIds } }] }, select: { id: true } })).map((d) => d.id);
    const decls = (await prisma.medicalInfoDeclaration.findMany({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: pieces } }, select: { id: true } })).map((d) => d.id);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: decls } } }).catch(() => {});
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: pieces } }, select: { id: true } })).map((o) => o.id);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: pieces } }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { OR: [{ entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }, { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }] } }).catch(() => {});
    await prisma.promoQuote.updateMany({ where: { promoMaterialId: { in: pmIds } }, data: { purchaseOrderId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: pieces } }, data: { chainFromId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: { in: pmIds } } }).catch(() => {});
    // Le stock reçu (§118.165), puis le catalogue — un article demandé retient son article du catalogue.
    await prisma.promoStockMovement.deleteMany({ where: { item: { companyId } } }).catch(() => {});
    await prisma.promoStockLot.deleteMany({ where: { item: { companyId } } }).catch(() => {});
    await prisma.promoStockItem.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    // Les lignes demandées sont parties avec leurs dossiers : le produit ne leur est plus retenu.
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { id: buBanc } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: autreSociete } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: pmIds } } }).catch(() => {});
    const ids = Object.values(u);
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 60_000);

  it("PRÉMISSES : le N+1 d'un délégué n'a le module qu'en « ses lignes » ; le chef de produit n'a pas Legal ; les Finances n'ont pas Legal", async () => {
    // §118.153 : le National Sales DEMANDE lui aussi du matériel promotionnel — il a le module,
    // mais en portée « ses lignes ». Le dossier de SON KAM n'y est pas : c'est la porte de la fiche
    // (le N+1 nommé) qui le lui ouvre, et c'est elle que ce banc mesure.
    const ns = await actorFor(u.ns);
    expect(userCan(ns, "PROMO_MATERIAL", "VIEW")).toBe(true);
    expect(ns.access.modules.get("PROMO_MATERIAL")?.scope, "sans cela, la porte de la fiche ne se mesurerait pas").toBe("ASSIGNED");
    expect(userCan(await actorFor(u.cp), "LEGAL", "VIEW")).toBe(false);
    expect(userCan(await actorFor(u.cp), "PROMO_MATERIAL", "CREATE")).toBe(true);
    expect(userCan(await actorFor(u.fin), "LEGAL", "VIEW")).toBe(false);
    expect(userCan(await actorFor(u.fin), "FINANCES", "VIEW")).toBe(true);
    // Ni le demandeur ni l'assistante ne peuvent ENGAGER la société — ils la VOIENT, en salariés.
    // Sans cette prémisse, la génération des BC passerait par le droit nominatif et le banc ne
    // mesurerait pas la délégation qu'il existe pour mesurer.
    for (const k of ["cp", "asst"]) {
      expect(await canEditCompanyId(u[k], companyId), `${k} ne doit pas pouvoir engager la société`).toBe(false);
      expect((await getMyCompanies(u[k])).map((c) => c.id)).toContain(companyId);
    }
    expect((await getMyCompanies(u.dehors)).map((c) => c.id)).not.toContain(companyId);
  });

  it("LA RÈGLE, lue sur l'organigramme : directrice pour le marketing, N+1 pour le délégué, personne pour la directrice ni pour la Direction des opérations", async () => {
    const cp = await validateursDeLaDemande(u.cp);
    expect(cp.validateur).toMatchObject({ kind: "PERSONNE", userId: u.dir, qualite: "DIRECTRICE_MARKETING" });
    expect(cp.directriceId).toBe(u.dir);
    const kam = await validateursDeLaDemande(u.kam);
    expect(kam.validateur).toMatchObject({ kind: "PERSONNE", userId: u.ns, qualite: "N_PLUS_1" });
    const dir = await validateursDeLaDemande(u.dir);
    expect(dir.validateur.kind).toBe("AUCUNE");
    expect(dir.demandeurEstCheffe).toBe(true);
    expect((await validateursDeLaDemande(u.ops)).validateur.kind).toBe("AUCUNE");
  });

  it("LA DEMANDE NAÎT AVEC SES LIGNES (§118.171) : sans ligne, ou une ligne incomplète, rien n'est écrit — et tout ce qui manque se dit en une fois", async () => {
    const debut = new Date(Date.now() - 1_000);
    // « C'est directement ici que le demandeur ajoute les différentes lignes de matériel qu'il
    // cherche, la quantité et les actions. » La demande naissait VIDE, et son validateur, prévenu
    // à la création, tranchait une demande qui ne disait pas ce qu'elle demandait.
    ACTOR = await actorFor(u.cp);
    const sansLigne = await createPromoMaterial(undefined, form({ title: `${TAG} Sans ligne` }));
    expect(sansLigne.ok).toBe(false);
    expect(sansLigne.error).toBe(REFUS_SANS_LIGNE);

    // UNE FOIS (§118.18) : le titre ET les deux lignes fautives, dans le même refus, chacune nommée.
    const incomplete = await createPromoMaterial(undefined, form({
      title: "",
      lignes: JSON.stringify([
        { catalogueId: catCarnet, quantite: "500", actions: [] },
        { catalogueId: "", actions: ["IMPRESSION"] },
      ]),
    }));
    expect(incomplete.ok).toBe(false);
    expect(incomplete.error).toMatch(/titre/);
    expect(incomplete.error).toMatch(/Ligne 1 : Il manque au moins une action/);
    expect(incomplete.error).toMatch(/Ligne 2 : Choisissez l'article dans le catalogue/);
    // Une saisie illisible est refusée, jamais devinée.
    const illisible = await createPromoMaterial(undefined, form({ title: `${TAG} Illisible`, lignes: "{pas du json" }));
    expect(illisible.ok).toBe(false);
    expect(illisible.error).toMatch(/illisibles/);
    expect(await prisma.promoMaterial.count({ where: { title: { in: [`${TAG} Sans ligne`, `${TAG} Illisible`, ""] }, requesterId: u.cp } })).toBe(0);

    // Une ligne entièrement VIDE est un reste de formulaire : écartée, pas refusée. Les autres
    // naissent AVEC le dossier, dans l'ordre saisi, avec leurs produits et leurs actions.
    const lignes = [
      { catalogueId: catCarnet, quantite: "500", actions: ["CONCEPTION", "IMPRESSION"], commentaire: "A5, recto-verso", produitIds: [produitBanc] },
      { catalogueId: "", quantite: "", actions: [], produitIds: [], commentaire: "" },
      { catalogueId: catStand, quantite: "", actions: ["LOCATION"], commentaire: "" },
    ];
    const ok = await createPromoMaterial(undefined, form({ title: `${TAG} Deux lignes`, lignes: JSON.stringify(lignes) }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const items = await prisma.promoRequestItem.findMany({
      where: { promoMaterialId: ok.id! }, orderBy: { position: "asc" },
      select: { catalogueId: true, quantite: true, actions: true, commentaire: true, position: true, produits: { select: { productId: true } } },
    });
    expect(items.map((i) => [i.catalogueId, i.position, i.actions])).toEqual([
      [catCarnet, 0, ["CONCEPTION", "IMPRESSION"]],
      [catStand, 1, ["LOCATION"]],
    ]);
    expect(Number(items[0].quantite)).toBe(500);
    expect(items[0].commentaire).toBe("A5, recto-verso");
    expect(items[0].produits.map((p) => p.productId)).toEqual([produitBanc]);
    expect(items[1].quantite).toBeNull();

    // Ce décor ne doit rien laisser aux cas suivants. BORNÉ À CE CAS (`createdAt`) : par le seul
    // lien, Postgres parcourait toute la table — 4,9 millions de lignes de résidus de bancs dans la
    // base de travail, 1,1 Go lu (144 254 pages) —, et sous la suite complète le cas dépassait ses
    // 60 s alors qu'il en fait une seul (§118.175). La date passe par l'index ; le lien trie le reste.
    await prisma.notification.deleteMany({ where: { link: `/promo-material/${ok.id}`, createdAt: { gte: debut } } });
    await prisma.auditLog.deleteMany({ where: { entityId: ok.id! } }).catch(() => {});
    await prisma.promoMaterial.delete({ where: { id: ok.id! } });
  }, 60_000);

  it("CE QUE LA DEMANDE NE PORTE PLUS (décision du 01/10) : gamme, budget, assistante et entité FORGÉS sont ignorés", async () => {
    const debut = new Date(Date.now() - 1_000);
    // L'écran ne les propose plus ; une requête forgée les porterait quand même. Ignorés au
    // serveur, et l'ENTITÉ est celle où le demandeur travaille — un menu qui en laissait choisir
    // une autre laissait aussi forger une société qu'on ne voit pas.
    // Chaque valeur forgée désigne une ligne qui EXISTE : une action qui la lirait l'écrirait, et
    // l'égalité ci-dessous tomberait — un identifiant inventé ferait échouer l'écriture pour une
    // AUTRE raison, et ne prouverait rien de ce qu'on lit.
    ACTOR = await actorFor(u.cp);
    expect((await getMyCompanies(u.cp)).map((c) => c.id), "prémisse : l'autre société n'est pas la sienne").not.toContain(autreSociete);
    const r = await createPromoMaterial(undefined, form({
      title: `${TAG} Forgée`,
      lignes: JSON.stringify([{ catalogueId: catCarnet, quantite: "50", actions: ["IMPRESSION"] }]),
      businessUnitId: buBanc, amount: "900000", assistantId: u.dehors, companyId: autreSociete,
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: r.id! }, select: { businessUnitId: true, amount: true, assistantId: true, companyId: true } });
    expect(pm).toEqual({ businessUnitId: null, amount: null, assistantId: null, companyId });

    // L'ÉCRAN : le panneau commun charge le catalogue ACTIF pour cette nature, et rien pour une autre.
    const data = await getAdProCreateData(u.cp, ["PROMO_MATERIAL"]);
    expect(data.catalogueMateriel.catalogue.map((c) => c.id)).toEqual(expect.arrayContaining([catPresentoir, catStand, catCarnet]));
    expect((await getAdProCreateData(u.cp, ["EVENT"])).catalogueMateriel.catalogue).toEqual([]);

    await prisma.notification.deleteMany({ where: { link: `/promo-material/${r.id}`, createdAt: { gte: debut } } });
    await prisma.auditLog.deleteMany({ where: { entityId: r.id! } }).catch(() => {});
    await prisma.promoMaterial.delete({ where: { id: r.id! } });
  }, 60_000);

  it("ADAM NE COMPOSE PAS DE LIGNES : l'outil le dit AVANT toute carte, et une carte d'avant ne crée rien", async () => {
    // L'outil ne sait pas porter les lignes du catalogue. Proposer une carte que l'action refuserait
    // après le clic serait un geste offert puis retiré (§118.83) : le refus vient avant, et il nomme
    // l'écran qui sait faire. Une carte proposée AVANT le changement peut encore être confirmée :
    // elle ne crée rien non plus, et dit la même chose.
    const cp = await actorFor(u.cp);
    const carte = await buildProposal("create_promo_material_request", { title: `${TAG} Par Adam` }, cp);
    expect("error" in carte ? carte.error : "une carte a été proposée").toMatch(/se crée depuis Ad & Pro › Nouvelle demande › Matériel promotionnel/);
    const vieille = await performAction(cp, { kind: "create_promo_material_request", title: `${TAG} Carte d'avant`, amount: 50_000 });
    expect(vieille.ok).toBe(false);
    expect(vieille.error).toMatch(/se crée depuis Ad & Pro › Nouvelle demande › Matériel promotionnel/);
    expect(await prisma.promoMaterial.count({ where: { title: { in: [`${TAG} Par Adam`, `${TAG} Carte d'avant`] } } })).toBe(0);
  });

  it("CRÉATION : circuit 2, validateur FIGÉ, et c'est lui — pas tout le monde — qui est prévenu", async () => {
    ACTOR = await actorFor(u.cp);
    const r = await createPromoMaterial(undefined, form({
      title: `${TAG} Présentoirs Nivolex`,
      lignes: JSON.stringify([{ catalogueId: catPresentoir, quantite: "100", actions: ["FABRICATION"], commentaire: "Sol, 160 cm" }]),
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    pmId = r.id!;
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId } });
    expect(pm).toMatchObject({ circuitVersion: 2, circuitState: "REVIEW_REQUEST", requestValidatorId: u.dir, requestValidation: true, marketingValidatorId: u.dir });
    // Aucune demande au secrétariat à la création : on ne fait pas travailler les agences sur une demande non validée.
    expect(pm.adminRequestId).toBeNull();
    expect(await prisma.notification.count({ where: { userId: u.dir, link: `/promo-material/${pmId}` } })).toBe(1);
  });

  it("VALIDER LA DEMANDE : ni le demandeur, ni un tiers — la directrice figée ; un envoi automatique qui ne peut pas partir le DIT", async () => {
    ACTOR = await actorFor(u.cp);
    expect((await validatePromoStep(form({ id: pmId }))).ok).toBe(false);
    ACTOR = await actorFor(u.dehors);
    expect((await validatePromoStep(form({ id: pmId }))).ok).toBe(false);
    // §118.165 : sans article demandé, l'assistante ne saurait pas quels devis chercher. La demande NAÎT avec
    // ses lignes (§118.171) ; ce garde-fou reste atteignable si le demandeur retire la dernière ligne avant la
    // validation — la demande de devis, qui part d'elle-même à la validation (§118.204), ne part alors PAS.
    ACTOR = await actorFor(u.cp);
    const premiere = await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: pmId }, select: { id: true } });
    const retrait = await retirerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: premiere.id }));
    expect(retrait.ok, retrait.ok ? "" : retrait.error).toBe(true);
    ACTOR = await actorFor(u.dir);
    const r = await validatePromoStep(form({ id: pmId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/n'est pas partie d'elle-même.*articles à faire chiffrer/s);
    expect((await etatDe(pmId)).circuitState).toBe("QUOTE_TO_REQUEST");
    expect(await prisma.administrativeRequest.count({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: pmId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: u.cp, title: "Demande validée — envoyez la demande de devis depuis « Articles demandés »" } })).toBe(1);
  });

  it("ENVOYER LA DEMANDE DE DEVIS (le repli) : le demandeur, une fois les articles posés ; la demande au secrétariat porte le lien canonique", async () => {
    ACTOR = await actorFor(u.asst);
    expect((await demanderDevisPromo(form({ promoMaterialId: pmId }))).ok, "l'assistante n'envoie pas à la place du demandeur").toBe(false);
    ACTOR = await actorFor(u.cp);
    const sansArticle = await demanderDevisPromo(form({ promoMaterialId: pmId }));
    expect(sansArticle.ok).toBe(false);
    expect(sansArticle.ok ? "" : sansArticle.error).toMatch(/articles à faire chiffrer/);
    const art = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catPresentoir, quantite: "100", actions: ["FABRICATION"], commentaire: "Sol, 160 cm" }));
    expect(art.ok, art.ok ? "" : art.error).toBe(true);
    const r = await demanderDevisPromo(form({ promoMaterialId: pmId, note: "Trois agences au moins" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { circuitState: true, adminRequestId: true } });
    expect(pm.circuitState).toBe("QUOTE_REQUESTED");
    const dem = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: pm.adminRequestId! } });
    // Aucune assistante n'est plus nommée à la création (§118.171) : la demande n'est assignée à
    // personne, et TOUT le secrétariat est prévenu — dont l'assistante du banc.
    expect(dem).toMatchObject({ type: "QUOTE", linkedEntityType: "PROMO_MATERIAL", linkedEntityId: pmId, assignedToId: null });
    expect(await prisma.notification.count({ where: { userId: u.asst, link: `/promo-material/${pmId}` } })).toBeGreaterThanOrEqual(1);
    // La demande au secrétariat DIT les articles : l'assistante sait quoi chercher sans ouvrir la fiche.
    expect(dem.description).toMatch(/Présentoir PLV.*100.*fabrication.*Sol, 160 cm/s);
    // Un double clic ne fait pas une seconde demande.
    expect((await demanderDevisPromo(form({ promoMaterialId: pmId }))).ok).toBe(false);
    expect(await prisma.administrativeRequest.count({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: pmId } })).toBe(1);
  });

  it("RETRANSCRIRE : l'assistante, pas le demandeur ; un écart avec le total imprimé bloque la fin, et se DIT", async () => {
    ACTOR = await actorFor(u.cp);
    const refus = await enregistrerDevisPromo(form({ promoMaterialId: pmId, supplierId: fourA, ligneReference: "X", ligneQuantite: "1", lignePrix: "1", ligneAction: "IMPRESSION" }));
    expect(refus.ok, "celui qui recopie les prix n'est pas celui qui les retient").toBe(false);

    ACTOR = await actorFor(u.asst);
    const article = (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: pmId } })).id;
    // §118.165 : une ligne sans ACTION est refusée — c'est elle qui dira à la réception si ce qui arrive entre au stock.
    const sansAction = form({ promoMaterialId: pmId, supplierId: fourA, ligneReference: ["Présentoir"], ligneQuantite: ["1"], lignePrix: ["1"] });
    sansAction.set("scan", pdf("x.pdf"));
    const refusAction = await enregistrerDevisPromo(sansAction);
    expect(refusAction.ok).toBe(false);
    expect(refusAction.ok ? "" : refusAction.error).toMatch(/action/);
    const fd = form({
      promoMaterialId: pmId, supplierId: fourA, reference: "A-26/057", quoteDate: "2026-09-20", tvaRate: "19", announcedTotal: "999999",
      ligneReference: ["Présentoir PLV sol", "Kakemono 80×200"], ligneUnite: ["pièce", "pièce"], ligneQuantite: ["100", "40"], lignePrix: ["10000", "5000"],
      ligneAction: ["FABRICATION", "IMPRESSION"], ligneArticle: [article, ""],
    });
    fd.set("scan", pdf("devis-atlas.pdf"));
    const a = await enregistrerDevisPromo(fd);
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    const fdB = form({
      promoMaterialId: pmId, supplierId: fourB, reference: "S-114", tvaRate: "19", extraTaxLabel: "Taxe Pub", extraTaxRate: "2", announcedTotal: "300000",
      ligneReference: ["Stand modulaire 3×3"], ligneQuantite: ["1"], lignePrix: ["300000"], ligneAction: ["FABRICATION"],
    });
    fdB.set("scan", pdf("devis-sahel.pdf"));
    const b = await enregistrerDevisPromo(fdB);
    expect(b.ok, b.ok ? "" : b.error).toBe(true);

    const trop = await terminerRetranscriptionPromo(form({ promoMaterialId: pmId }));
    expect(trop.ok).toBe(false);
    expect(trop.ok ? "" : trop.error).toMatch(/Atlas.*annonce/);

    // La correction : le total imprimé était 1 200 000 HT (100 × 10 000 + 40 × 5 000).
    const fix = form({
      promoMaterialId: pmId, quoteId: a.id!, supplierId: fourA, reference: "A-26/057", tvaRate: "19", announcedTotal: "1200000",
      ligneReference: ["Présentoir PLV sol", "Kakemono 80×200"], ligneUnite: ["pièce", "pièce"], ligneQuantite: ["100", "40"], lignePrix: ["10000", "5000"],
      ligneAction: ["FABRICATION", "IMPRESSION"], ligneArticle: [article, ""],
    });
    expect((await enregistrerDevisPromo(fix)).ok).toBe(true);
    const fin = await terminerRetranscriptionPromo(form({ promoMaterialId: pmId }));
    expect(fin.ok, fin.ok ? "" : fin.error).toBe(true);
    expect((await etatDe(pmId)).circuitState).toBe("REVIEW_REQUESTER");
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { adminRequestId: true } });
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: pm.adminRequestId! } })).status).toBe("DONE");
  });

  it("CHOISIR : « valider les lignes de plusieurs devis » — le montant retenu est FIGÉ au TTC, chaque devis avec SA taxe", async () => {
    const lignes = await prisma.promoQuoteLine.findMany({ where: { quote: { promoMaterialId: pmId } }, select: { id: true, reference: true } });
    const presentoir = lignes.find((l) => l.reference === "Présentoir PLV sol")!.id;
    const stand = lignes.find((l) => l.reference === "Stand modulaire 3×3")!.id;

    ACTOR = await actorFor(u.asst);
    expect((await choisirLignesPromo(form({ promoMaterialId: pmId, lineIds: [presentoir] }))).ok, "le choix revient au demandeur").toBe(false);

    ACTOR = await actorFor(u.cp);
    const vide = await choisirLignesPromo(form({ promoMaterialId: pmId, valider: "1" }));
    expect(vide.ok).toBe(false);
    // PAR ADAM, par son VRAI point d'entrée : « je retiens le présentoir et le stand, valide ».
    // La carte montre ce que le clic fixera AVANT le clic ; l'exécution passe par la même action.
    const reference = (await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { reference: true } })).reference;
    const cp = await actorFor(u.cp);
    const carte = await DOMAIN_TOOLS.promo_operation.ops.choose_promo_lines.impl.propose({ reference, lines: "Présentoir; Sahel : Stand modulaire", mode: "valider" }, cp);
    if ("error" in carte) throw new Error(carte.error);
    expect(carte.fields.find((f) => f.label === "Total retenu")?.value).toMatch(/1\s553\s000/);
    expect(carte.args.lineIds?.split(",").sort()).toEqual([presentoir, stand].sort());
    const r = await DOMAIN_TOOLS.promo_operation.ops.choose_promo_lines.impl.execute(carte.args, cp);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pm = await etatDe(pmId);
    // Atlas : 1 000 000 HT + 19 % = 1 190 000 ; Sahel : 300 000 + 57 000 TVA + 6 000 Taxe Pub = 363 000.
    expect(Number(pm.chosenAmount)).toBe(1_553_000);
    expect(pm.chosenAgency).toContain("Atlas");
    expect(pm.chosenAgency).toContain("Sahel");
    expect(pm.circuitState).toBe("REVIEW_MANAGER");
    // Plafond LOCAL, mesure à côté (§118.124b) : ce cas fait moins de 300 ms seul (le fichier entier
    // 3,4 s) et a dépassé les 20 000 ms globales sous 893 fichiers — le fichier y a pris 65 s. Un plafond
    // répond à « est-il bloqué ? », jamais à « est-il lent ? » ; le global ne bouge pas.
  }, 120_000);

  it("DIRECTION MARKETING : la directrice du demandeur valide ; le DG ensuite, au-dessus du seuil", async () => {
    ACTOR = await actorFor(u.ns2);
    expect((await validatePromoStep(form({ id: pmId }))).ok).toBe(false);
    ACTOR = await actorFor(u.dir);
    const r = await validatePromoStep(form({ id: pmId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const dgAttendu = seuilDg > 0 && 1_553_000 > seuilDg;
    expect((await etatDe(pmId)).circuitState).toBe(dgAttendu ? "REVIEW_DG" : "IN_EXECUTION");
    if (dgAttendu) {
      ACTOR = await actorFor(u.dir);
      expect((await validatePromoStep(form({ id: pmId }))).ok, "la directrice ne tranche pas l'étape du DG").toBe(false);
      ACTOR = await actorFor(u.dg);
      const g = await validatePromoStep(form({ id: pmId }));
      expect(g.ok, g.ok ? "" : g.error).toBe(true);
    }
    expect((await etatDe(pmId)).circuitState).toBe("IN_EXECUTION");
  });

  it("L'ANCIEN PARCOURS NE PILOTE PAS CE DOSSIER, et on ne l'annule pas avec des BC engagés", async () => {
    ACTOR = await actorFor(u.asst);
    const r = await submitQuotes(form({ id: pmId }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/Suivi du circuit/);
  });

  it("LA DÉLÉGATION vaut pour la société NOMMÉE, et seulement pour qui la VOIT — aucun numéro consommé sur un refus", async () => {
    const avant = await prisma.legalDocument.count({ where: { companyId } });
    const bc = { type: "BON_DE_COMMANDE" as const, tiers: { nom: "Tiers du banc", adresse: "Alger", nif: "0003" }, lignes: [{ designation: "Présentoir", quantite: 1, prixUnitaire: 1000 }] };
    const delegation = { source: { type: "PROMO_MATERIAL" as const, id: pmId }, delegation: "banc — délégation" };
    // Sans société nommée : pas de repli sur celle de la personne qui clique.
    const sansSociete = await emettreDocumentDrive(await actorFor(u.asst), { ...bc, societe: null }, delegation);
    expect(sansSociete.ok).toBe(false);
    if (!sansSociete.ok) expect(sansSociete.motif).toMatch(/ne nomme aucune société/);
    // Quelqu'un que le groupe tient HORS de la société : la délégation ne lui ouvre pas l'entité.
    const horsSociete = await emettreDocumentDrive(await actorFor(u.dehors), { ...bc, societe: companyId }, delegation);
    expect(horsSociete.ok).toBe(false);
    // Et SANS délégation, l'assistante — qui voit la société sans pouvoir l'engager ni écrire dans
    // Legal — reste refusée : la délégation est le seul chemin, pas un assouplissement général.
    const sansDelegation = await emettreDocumentDrive(await actorFor(u.asst), { ...bc, societe: companyId });
    expect(sansDelegation.ok).toBe(false);
    expect(await prisma.legalDocument.count({ where: { companyId } })).toBe(avant);
  });

  it("GÉNÉRER LES BC : un par fournisseur retenu, composés par la plateforme, tagués au dossier — et idempotents", async () => {
    ACTOR = await actorFor(u.dehors);
    expect((await genererBonsDeCommandePromo(form({ promoMaterialId: pmId }))).ok).toBe(false);
    ACTOR = await actorFor(u.asst);
    const r = await genererBonsDeCommandePromo(form({ promoMaterialId: pmId, livraisonAdresse: "Siège, Alger" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    // DEUX TEMPS (Direction, 10/2026) : la génération dépose un APERÇU par devis retenu — aucun numéro, rien au registre.
    expect(await prisma.legalDocument.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId, kind: "PURCHASE_ORDER" } })).toBe(0);
    const apercus = await prisma.promoQuote.findMany({ where: { promoMaterialId: pmId, lines: { some: { selected: true } } }, select: { id: true, bcBrouillon: true } });
    expect(apercus.length).toBe(2);
    expect(apercus.every((q) => q.bcBrouillon !== null), "un aperçu par devis retenu").toBe(true);
    // L'assistante prépare, mais ne valide pas à la place du demandeur.
    const parAssistante = await validerEtEnvoyerBcPromo(form({ promoMaterialId: pmId, quoteId: apercus[0]!.id }));
    expect(parAssistante.ok).toBe(false);
    ACTOR = await actorFor(u.cp);
    for (const q of apercus) {
      const v = await validerEtEnvoyerBcPromo(form({ promoMaterialId: pmId, quoteId: q.id }));
      expect(v.ok, v.ok ? "" : v.error).toBe(true);
    }
    const restants = (await prisma.promoQuote.findMany({ where: { promoMaterialId: pmId }, select: { bcBrouillon: true } })).filter((q) => q.bcBrouillon !== null);
    expect(restants, "l'aperçu validé est consommé").toHaveLength(0);
    ACTOR = await actorFor(u.asst);
    const bcs = await prisma.legalDocument.findMany({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId, kind: "PURCHASE_ORDER" } });
    expect(bcs).toHaveLength(2);
    expect(bcs.map((b) => Number(b.amount)).sort((x, y) => x - y)).toEqual([363_000, 1_190_000]);
    // Encore : rien de nouveau.
    const encore = await genererBonsDeCommandePromo(form({ promoMaterialId: pmId }));
    expect(encore.ok).toBe(true);
    expect(await prisma.legalDocument.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId, kind: "PURCHASE_ORDER" } })).toBe(2);

    ACTOR = await actorFor(u.cp);
    // AVEC un motif : sans lui, le refus viendrait du motif manquant et ce cas passerait pour la mauvaise
    // raison (§118.111) — c'est bien les BC générés qui doivent l'arrêter.
    const annul = await cancelPromoMaterial(form({ id: pmId, motif: "Projet abandonné." }));
    expect(annul.ok, "un dossier avec des BC générés ne s'annule pas en laissant les commandes vivantes").toBe(false);
    expect(annul.error).toMatch(/de commande ont été générés pour ce dossier/);
  }, 120_000);

  it("LA CASE « TAXE SUPPLÉMENTAIRE » (Direction, 10/2026) : un taux la pose, le libellé reste quand on ne change que le taux, 0 la retire, vide la garde — un taux illisible refuse sans rien écrire", async () => {
    ACTOR = await actorFor(u.asst);
    const devis = await prisma.promoQuote.findFirstOrThrow({ where: { promoMaterialId: pmId, purchaseOrderId: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true, purchaseOrderId: true } });
    const piece = () => prisma.legalDocument.findUniqueOrThrow({ where: { id: devis.purchaseOrderId! }, select: { amount: true, custom: true } });
    const specDe = async () => ((await piece()).custom as unknown as { fabrique: { spec: SpecDocumentCommercial } }).fabrique.spec;
    const avant = Number((await piece()).amount);
    expect((await specDe()).taxes ?? []).toEqual([]);
    const base = { promoMaterialId: pmId, quoteId: devis.id };

    // Un taux illisible ou hors de 0–100 est refusé EN LE NOMMANT, et rien n'est écrit.
    for (const mauvais of ["abc", "101", "-2"]) {
      const r = await modifierBonDeCommandePromo(form({ ...base, extraTaxRate: mauvais }));
      expect(r.ok, `« ${mauvais} » doit être refusé`).toBe(false);
      expect(r.error).toMatch(/pour cent/);
    }
    expect(Number((await piece()).amount)).toBe(avant);

    // POSÉE : « Taxe Pub 2 % » — le total suit, calculé par la fabrique (sur le HT, hors base de TVA).
    const pose = await modifierBonDeCommandePromo(form({ ...base, extraTaxLabel: "Taxe Pub", extraTaxRate: "2", motif: "Taxe Pub demandée" }));
    expect(pose.ok, pose.ok ? "" : pose.error).toBe(true);
    expect((await specDe()).taxes).toEqual([{ libelle: "Taxe Pub", taux: 0.02 }]);
    const apresPose = Number((await piece()).amount);
    expect(apresPose).toBe(calculerTotaux(await specDe()).totalTtc);
    expect(apresPose).toBeGreaterThan(avant);

    // LE TAUX SEUL, avec une virgule : le libellé de la pièce reste « Taxe Pub » (il ne devient pas « Taxe additionnelle »).
    const taux = await modifierBonDeCommandePromo(form({ ...base, extraTaxRate: "3,5" }));
    expect(taux.ok, taux.ok ? "" : taux.error).toBe(true);
    expect((await specDe()).taxes).toEqual([{ libelle: "Taxe Pub", taux: 0.035 }]);

    // VIDE : la taxe est gardée — une modification des notes seules ne la touche pas.
    const notes = await modifierBonDeCommandePromo(form({ ...base, notes: "À livrer avant la fin du mois", extraTaxRate: "" }));
    expect(notes.ok, notes.ok ? "" : notes.error).toBe(true);
    expect((await specDe()).taxes).toEqual([{ libelle: "Taxe Pub", taux: 0.035 }]);

    // 0 : aucune taxe — le total revient exactement à celui d'avant la taxe.
    const retire = await modifierBonDeCommandePromo(form({ ...base, extraTaxRate: "0" }));
    expect(retire.ok, retire.ok ? "" : retire.error).toBe(true);
    expect((await specDe()).taxes ?? []).toEqual([]);
    expect(Number((await piece()).amount)).toBe(avant);
  }, 120_000);

  it("LE N° DE RÉFÉRENCE DU BC PROMOTIONNEL SE MODIFIE (Direction, 14/10/2026) : porté par l'autre BC du dossier → refusé ; libre → écrit, imprimé, tracé", async () => {
    ACTOR = await actorFor(u.asst);
    const [premier, second] = await prisma.promoQuote.findMany({ where: { promoMaterialId: pmId, purchaseOrderId: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true, purchaseOrderId: true } });
    const ref = async (id: string) => (await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { reference: true } })).reference!;
    const ancien = await ref(premier.purchaseOrderId!);
    const base = { promoMaterialId: pmId, quoteId: premier.id, numeroActuel: ancien, motif: "Numéro corrigé" };
    const pris = await modifierBonDeCommandePromo(form({ ...base, numeroRevise: await ref(second.purchaseOrderId!) }));
    expect(pris.ok).toBe(false);
    expect(pris.error).toMatch(/déjà porté/);
    const nouveau = `${ancien}-B`;
    const ok = await modifierBonDeCommandePromo(form({ ...base, numeroRevise: nouveau }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(ok.message).toContain(nouveau);
    expect(await ref(premier.purchaseOrderId!)).toBe(nouveau);
    expect(await prisma.auditLog.findFirst({ where: { entityId: premier.purchaseOrderId!, field: "numero" }, select: { oldValue: true, newValue: true } })).toEqual({ oldValue: ancien, newValue: nouveau });

    // NUMÉRO SEUL SUR UN BC SIGNÉ ET ENVOYÉ (Direction, 14/10/2026) : signature, étapes, envoi au fournisseur — tout est gardé.
    const bcId = premier.purchaseOrderId!;
    const envoi = () => prisma.promoQuote.findUniqueOrThrow({ where: { id: premier.id }, select: { purchaseOrderSentAt: true } });
    await prisma.legalDocument.update({ where: { id: bcId }, data: { signedAt: new Date("2026-04-01T10:00:00Z"), signedById: u.fin, signedByName: "Finances" } });
    await prisma.promoQuote.update({ where: { id: premier.id }, data: { purchaseOrderSentAt: new Date("2026-04-02T10:00:00Z") } });
    const avant = await etatCompletDuBC(bcId);
    const seul = await modifierBonDeCommandePromo(form({ ...base, numeroActuel: nouveau, numeroRevise: `${ancien}-C` }));
    expect(seul.ok, seul.ok ? "" : seul.error).toBe(true);
    expect(seul.message).toMatch(/seul le numéro a changé/);
    expect(await etatCompletDuBC(bcId)).toEqual(avant);
    expect((await envoi()).purchaseOrderSentAt).not.toBeNull();
    // NUMÉRO + NOTES : la règle d'avant — révision ordinaire (réaiguillée), l'envoi au fournisseur est à refaire.
    const avec = await modifierBonDeCommandePromo(form({ ...base, numeroActuel: `${ancien}-C`, numeroRevise: ancien, notes: "Livrer au dépôt de Blida" }));
    expect(avec.ok, avec.ok ? "" : avec.error).toBe(true);
    expect(avec.message).not.toMatch(/seul le numéro/);
    expect((await envoi()).purchaseOrderSentAt).toBeNull();
    const histo = ((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } })).custom as { fabrique: { historique: { numeroSeul?: boolean }[] } }).fabrique.historique;
    expect(histo.at(-1)?.numeroSeul).toBeUndefined();
    expect(histo.at(-2)?.numeroSeul).toBe(true);
    await prisma.legalDocument.update({ where: { id: bcId }, data: { signedAt: null, signedById: null, signedByName: null } });
    expect(await ref(bcId)).toBe(ancien);
  }, 120_000);

  it("LE FICHIER DU BC s'ouvre sous la porte de la PIÈCE : le demandeur et les Finances le lisent, pas un tiers", async () => {
    const bc = await prisma.legalDocument.findFirstOrThrow({ where: { sourceType: "PROMO_MATERIAL", sourceId: pmId, kind: "PURCHASE_ORDER" }, select: { id: true, custom: true } });
    const f = fichiersEmis(bc.custom);
    expect(f.docx).toBeTruthy();
    // PRÉMISSE : le demandeur a validé l'aperçu, donc émis — le fichier vit dans SON Drive : les Finances ne l'y lisent pas.
    const cp = await actorFor(u.cp);
    expect(canViewDrive(await resolveDriveAccess(await actorFor(u.fin), f.docx!)), "sans cela, la route de la pièce ne répare rien").toBe(false);
    expect(await fichierEmisDeLaPiece(cp, bc.id, "docx")).toEqual({ nodeId: f.docx });
    expect(await fichierEmisDeLaPiece(await actorFor(u.fin), bc.id, "docx")).toEqual({ nodeId: f.docx });
    expect(await fichierEmisDeLaPiece(await actorFor(u.dehors), bc.id, "docx")).toBeNull();
    // LE CLASSEUR EXCEL (« générer le BC sur Excel ») : même porte que le Word — la spécification se lit pour qui lit la pièce, pas pour un tiers —,
    // et le classeur retombe, au centime, sur le montant de la pièce au registre.
    const spec = await specDeLaPieceEmise(cp, bc.id);
    expect(spec, "le demandeur lit la spécification de la pièce de son dossier").not.toBeNull();
    expect(await specDeLaPieceEmise(await actorFor(u.fin), bc.id)).not.toBeNull();
    expect(await specDeLaPieceEmise(await actorFor(u.dehors), bc.id)).toBeNull();
    const classeur = await construireXlsxCommercial(spec!);
    expect(classeur.verification.bloquants).toEqual([]);
    expect(classeur.verification.ok).toBe(true);
    const registre = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc.id }, select: { amount: true } });
    expect(calculerTotaux(spec!).totalTtc).toBe(Number(registre.amount));
  });

  it("CENTRE puis SIGNATURE : pas d'envoi ni de facture avant la signature des Finances", async () => {
    const execution = await executionDuDossier(pmId);
    const [q1] = execution.filter((e) => e.bc);

    // MODIFIER LE DÉLAI SEUL, PAR ADAM : l'adresse posée à la génération RESTE (§118.152). Le
    // formulaire n'est pas pré-rempli et Adam ne nomme que ce qui change — écrire `null` pour
    // chaque champ absent effaçait l'adresse de livraison, sans un mot.
    const reference = (await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { reference: true } })).reference;
    const cp = await actorFor(u.cp);
    ACTOR = cp;
    const carte = await DOMAIN_TOOLS.promo_operation.ops.update_promo_bc.impl.propose({ reference, supplier: q1.fournisseur, delay: "15 jours" }, cp);
    if ("error" in carte) throw new Error(carte.error);
    const modif = await DOMAIN_TOOLS.promo_operation.ops.update_promo_bc.impl.execute(carte.args, cp);
    expect(modif.ok, modif.ok ? "" : modif.error).toBe(true);
    const spec = ((await prisma.legalDocument.findUniqueOrThrow({ where: { id: q1.bc!.id }, select: { custom: true } })).custom as { fabrique: { spec: { livraison?: unknown } } }).fabrique.spec;
    // `date: null` : la DATE DE LIVRAISON est un champ voulu de la livraison depuis 9ddcc340 (« BC automatiques via
    // aperçu » — `demandeDuBcPromo` la reprend de l'aperçu, `null` quand l'aperçu n'en pose pas). Ce banc, écrit avant
    // (4009cb07), ne la connaissait pas, et son échec ne s'est vu qu'une fois le mock de session réparé (15f0eff1).
    // L'égalité reste stricte : la révision partielle garde aussi cette date telle qu'elle était (§118.152c).
    expect(spec.livraison).toEqual({ adresse: "Siège, Alger", delai: "15 jours", date: null });
    // La délégation ouvre LA pièce, jamais le Drive de l'émettrice : nommer la pièce q1 pour écrire
    // le fichier d'une AUTRE pièce est refusé par le port, qui vérifie que le fichier est le sien.
    const autreBc = execution.filter((e) => e.bc && e.bc.id !== q1.bc!.id)[0];
    const autreFichier = fichiersEmis((await prisma.legalDocument.findUniqueOrThrow({ where: { id: autreBc.bc!.id }, select: { custom: true } })).custom).docx!;
    // L'ACTEUR EST L'ASSISTANTE, plus le demandeur : depuis 9ddcc340 (« BC automatiques via aperçu »), c'est le DEMANDEUR
    // qui valide l'aperçu, donc émet — les fichiers des deux BC vivent dans SON Drive (prémisse du cas « LE FICHIER DU BC »).
    // Le demandeur a donc le droit d'écrire l'autre fichier par le Drive lui-même, et le refus ne prouvait plus rien.
    // L'assistante pilote le dossier sans aucun droit sur ce Drive : c'est elle que la délégation doit arrêter.
    expect(canEditDrive(await resolveDriveAccess(await actorFor(u.asst), autreFichier)), "PRÉMISSE : sans droit Drive, seule la pièce pourrait ouvrir").toBe(false);
    await expect(portsArtefact.documents.ecrireVersion(u.asst, autreFichier, Buffer.from("x"), { mime: "application/octet-stream", resume: "banc", piece: q1.bc!.id }))
      .rejects.toThrow(/pas le droit de modifier/);

    ACTOR = await actorFor(u.cp);
    expect((await marquerBonDeCommandeEnvoye(form({ promoMaterialId: pmId, quoteId: q1.quoteId }))).ok).toBe(false);
    const avant = form({ promoMaterialId: pmId, quoteId: q1.quoteId, reference: "F-1", amount: "1000" });
    avant.set("file", pdf("f1.pdf"));
    expect((await deposerFacturePromo(avant)).ok).toBe(false);

    for (const e of execution.filter((x) => x.bc)) {
      const etat = await etatDuBC(e.bc!.id);
      if (etat?.etape === "A_VALIDER") {
        ACTOR = await actorFor(u.dg);
        const v = await deciderVisaCentreAdPro(form({ entityType: "LEGAL_DOCUMENT", entityId: e.bc!.id, approve: "1" }));
        expect(v.ok, v.ok ? "" : v.error).toBe(true);
      }
      ACTOR = await actorFor(u.fin);
      const s = await signerBonDeCommande(avecCopieSignee(form({ id: e.bc!.id })));
      expect(s.ok, s.ok ? "" : s.error).toBe(true);
      expect((await etatDuBC(e.bc!.id))?.etape).toBe("SIGNE");
    }
    ACTOR = await actorFor(u.cp);
    expect((await marquerBonDeCommandeEnvoye(form({ promoMaterialId: pmId, quoteId: q1.quoteId }))).ok).toBe(true);
    ACTOR = await actorFor(u.cp);
    const chantier = await completePromoTrack(form({ id: pmId, track: "PURCHASE_ORDER" }));
    expect(chantier.ok, chantier.ok ? "" : chantier.error).toBe(true);
  }, 120_000);

  it("FACTURES : une par BC, fichier obligatoire, jamais au-delà du montant du BC", async () => {
    const execution = await executionDuDossier(pmId);
    ACTOR = await actorFor(u.cp);
    for (const e of execution.filter((x) => x.bc)) {
      const sansFichier = await deposerFacturePromo(form({ promoMaterialId: pmId, quoteId: e.quoteId, reference: `F-${e.fournisseur.slice(-5)}`, amount: String(e.bc!.montant) }));
      expect(sansFichier.ok).toBe(false);
      expect(sansFichier.ok ? "" : sansFichier.error).toMatch(/fichier/);
      const trop = form({ promoMaterialId: pmId, quoteId: e.quoteId, reference: "F-TROP", amount: String((e.bc!.montant ?? 0) + 5000) });
      trop.set("file", pdf("trop.pdf"));
      expect((await deposerFacturePromo(trop)).ok, "on ne paie pas plus que la commande validée").toBe(false);
      const ok = form({ promoMaterialId: pmId, quoteId: e.quoteId, reference: `F-${e.quoteId.slice(-4)}`, amount: String(e.bc!.montant), invoiceDate: "2026-09-25" });
      ok.set("file", pdf("facture.pdf"));
      const r = await deposerFacturePromo(ok);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    // Les Finances lisent la facture (et son fichier) : la même porte que la fiche Legal.
    const facture = await prisma.legalDocument.findFirstOrThrow({ where: { kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pmId } });
    expect(await canAccessEntity(await actorFor(u.fin), "LEGAL_DOCUMENT", facture.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(await actorFor(u.cp), "LEGAL_DOCUMENT", facture.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(await actorFor(u.dehors), "LEGAL_DOCUMENT", facture.id, "VIEW")).toBe(false);
  }, 120_000);

  it("PAIEMENT : au centre de paiement, et la demande de visa part AVEC — une fois, sans montant", async () => {
    const factures = await prisma.legalDocument.findMany({ where: { kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pmId } });
    expect(factures).toHaveLength(2);
    ACTOR = await actorFor(u.cp);
    expect((await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factures[0].id }))).ok, "la formalité est obligatoire").toBe(false);
    // §118.165 : le paiement attend la RÉCEPTION — puis le demandeur coche ce qui est arrivé. Le
    // présentoir entre dans l'article demandé ; le stand, « en plus », choisit son article ici.
    const attente = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factures[0].id, formalite: "AD_VISA" }));
    expect(attente.ok).toBe(false);
    expect(attente.ok ? "" : attente.error).toMatch(/pas reçue.*ne pourra pas être fait ultérieurement/s);
    const lignes = await prisma.promoFactureLigne.findMany({ where: { facture: { legalDocument: { sourceId: pmId } } }, select: { id: true, designation: true } });
    expect(lignes).toHaveLength(2);
    for (const l of lignes) {
      const enPlus = l.designation.startsWith("Stand");
      const r = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: l.id, ...(enPlus ? { catalogueId: catStand } : {}) }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    const stock = await prisma.promoStockItem.findMany({ where: { companyId }, select: { catalogueId: true, lots: { select: { origine: true, coutUnitaire: true } } } });
    expect(stock.map((s) => s.catalogueId).sort()).toEqual([catPresentoir, catStand].sort());
    expect(stock.flatMap((s) => s.lots).every((l) => l.origine === "ACHAT")).toBe(true);
    for (const f of factures) {
      const r = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: f.id, formalite: "AD_VISA" }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(r.message ?? "").toMatch(/centre de paiement/);
    }
    const encore = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factures[0].id, formalite: "AD_VISA" }));
    expect(encore.ok, "un second clic ne demande pas le même paiement deux fois").toBe(false);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: factures.map((f) => f.id) } } });
    expect(ordres).toHaveLength(2);
    expect(ordres.every((o) => o.centralStatus === "AWAITING")).toBe(true);
    const decls = await prisma.medicalInfoDeclaration.findMany({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: factures.map((f) => f.id) } } });
    expect(decls).toHaveLength(2);
    expect(decls.every((d) => d.declarationKind === "AD_VISA" && d.amount === null)).toBe(true);

    // Le pharmacien OUVRE le dossier dont il instruit le visa — sans le module.
    const pharma = await actorFor(u.pharma);
    expect(await peutOuvrirLeDossierPromo(pharma, { id: pmId, requesterId: u.cp, assistantId: u.asst, companyId: null })).toBe(true);
    // … et les Finances, qui LISENT l'information médicale pour les bons de versement, n'y entrent pas par là.
    expect(await peutOuvrirLeDossierPromo(await actorFor(u.dehors), { id: pmId, requesterId: u.cp, assistantId: u.asst, companyId: null })).toBe(false);

    // Le chantier « paiements » ne se clôt pas sur un paiement DEMANDÉ : il faut un paiement RÉGLÉ.
    ACTOR = await actorFor(u.cp);
    const tot = await completePromoTrack(form({ id: pmId, track: "PAYMENT" }));
    expect(tot.ok).toBe(false);
    expect(tot.ok ? "" : tot.error).toMatch(/pas encore réglé/);
    // Le visa, lui, est constaté : une demande par paiement.
    const visa = await completePromoTrack(form({ id: pmId, track: "AD_VISA" }));
    expect(visa.ok, visa.ok ? "" : visa.error).toBe(true);

    // Le centre autorise, les Finances règlent : le chantier se clôt, et le dossier avec.
    for (const o of ordres) {
      ACTOR = await actorFor(u.ops);
      const d = await decidePayment(form({ id: o.id, decision: "APPROVE" }));
      expect(d.ok, d.ok ? "" : d.error).toBe(true);
      await prisma.expenseOrder.update({ where: { id: o.id }, data: { status: "PAID", paidDate: new Date() } });
    }
    ACTOR = await actorFor(u.cp);
    const paye = await completePromoTrack(form({ id: pmId, track: "PAYMENT" }));
    expect(paye.ok, paye.ok ? "" : paye.error).toBe(true);
    expect((await etatDe(pmId)).circuitState).toBe("COMPLETED");
  }, 120_000);

  it("LE N+1 D'UN DÉLÉGUÉ : il ouvre la fiche et ses pièces hors de sa portée de module, et c'est lui seul qui tranche", async () => {
    const figes = await validateursDeLaDemande(u.kam);
    const pm = await prisma.promoMaterial.create({
      data: {
        reference: `${TAG}-KAM`, title: `${TAG} Carnets bilan`, status: "PROSPECTION_REQUESTED",
        circuitState: "REVIEW_REQUEST", circuitVersion: 2, requesterId: u.kam, createdById: u.kam, updatedById: u.kam,
        requestValidation: true, requestValidatorId: figes.validateur.kind === "PERSONNE" ? figes.validateur.userId : null,
        marketingValidatorId: figes.directriceId,
      },
    });
    kamPmId = pm.id;
    const ns = await actorFor(u.ns);
    expect(await peutOuvrirLeDossierPromo(ns, pm)).toBe(true);
    expect(await canAccessEntity(ns, "PROMO_MATERIAL", pm.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(await actorFor(u.ns2), "PROMO_MATERIAL", pm.id, "VIEW")).toBe(false);
    ACTOR = await actorFor(u.ns2);
    expect((await validatePromoStep(form({ id: pm.id }))).ok, "un autre superviseur n'est pas SON N+1").toBe(false);
    ACTOR = ns;
    const r = await validatePromoStep(form({ id: pm.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await etatDe(pm.id)).circuitState).toBe("QUOTE_TO_REQUEST");
  });

  it("DEMANDER UNE CORRECTION : le dossier revient à l'assistante, la sélection est effacée, le motif est au fil", async () => {
    ACTOR = await actorFor(u.kam);
    expect((await enregistrerArticleDemandePromo(form({ promoMaterialId: kamPmId, catalogueId: catCarnet, quantite: "500", actions: ["IMPRESSION"] }))).ok).toBe(true);
    const r0 = await demanderDevisPromo(form({ promoMaterialId: kamPmId }));
    expect(r0.ok, r0.ok ? "" : r0.error).toBe(true);
    ACTOR = await actorFor(u.asst);
    const fd = form({ promoMaterialId: kamPmId, supplierId: fourA, announcedTotal: "60000", ligneReference: ["Carnet A5"], ligneQuantite: ["500"], lignePrix: ["120"], ligneAction: ["IMPRESSION"] });
    fd.set("scan", pdf("devis.pdf"));
    expect((await enregistrerDevisPromo(fd)).ok).toBe(true);
    expect((await terminerRetranscriptionPromo(form({ promoMaterialId: kamPmId }))).ok).toBe(true);
    const ligne = await prisma.promoQuoteLine.findFirstOrThrow({ where: { quote: { promoMaterialId: kamPmId } } });
    ACTOR = await actorFor(u.kam);
    expect((await choisirLignesPromo(form({ promoMaterialId: kamPmId, lineIds: [ligne.id] }))).ok).toBe(true);
    expect((await demanderCorrectionDevisPromo(form({ promoMaterialId: kamPmId }))).ok, "sans motif, l'assistante reprendrait à l'identique").toBe(false);
    const c = await demanderCorrectionDevisPromo(form({ promoMaterialId: kamPmId, motif: "Le prix unitaire est 12 DZD, pas 120" }));
    expect(c.ok, c.ok ? "" : c.error).toBe(true);
    expect((await etatDe(kamPmId)).circuitState).toBe("QUOTE_REQUESTED");
    expect((await prisma.promoQuoteLine.findUniqueOrThrow({ where: { id: ligne.id } })).selected).toBe(false);

    // ADAM, SOUS LA PORTE DE LA FICHE. Le N+1 du délégué ouvre CE dossier et pas celui du chef de
    // produit : désigné par le fragment commun aux deux, il n'en reçoit qu'UN — l'autre n'est pas
    // même listé. Un autre superviseur n'en reçoit aucun, et le refus ne cite aucun titre.
    expect(await designerDossierPromo(await actorFor(u.ns), TAG)).toMatchObject({ id: kamPmId });
    const autre = await designerDossierPromo(await actorFor(u.ns2), TAG);
    expect("error" in autre && autre.error).toMatch(/parmi ceux qui vous sont ouverts/);
    expect(JSON.stringify(autre)).not.toMatch(/Présentoirs|Carnets/);
    // Un geste hors étape n'est pas OFFERT : le dossier attend la retranscription, pas un choix.
    const horsEtape = await DOMAIN_TOOLS.promo_operation.ops.choose_promo_lines.impl.propose({ reference: `${TAG}-KAM`, supplier: "Atlas" }, await actorFor(u.kam));
    expect("error" in horsEtape && horsEtape.error).toMatch(/n'attend pas le choix des lignes.*retranscription/i);
    expect(await prisma.comment.count({ where: { entityType: "PROMO_MATERIAL", entityId: kamPmId, body: { contains: "12 DZD" } } })).toBe(1);
  });

  it("REFUSER : le demandeur n'arrête pas son propre dossier par un refus (il l'annule) ; la Direction Marketing refuse, motif obligatoire, et le refus arrête le circuit", async () => {
    ACTOR = await actorFor(u.asst);
    const ligne = await prisma.promoQuoteLine.findFirstOrThrow({ where: { quote: { promoMaterialId: kamPmId } }, include: { quote: true } });
    const fix = form({ promoMaterialId: kamPmId, quoteId: ligne.quoteId, supplierId: fourA, announcedTotal: "6000", ligneReference: ["Carnet A5"], ligneQuantite: ["500"], lignePrix: ["12"], ligneAction: ["IMPRESSION"] });
    expect((await enregistrerDevisPromo(fix)).ok).toBe(true);
    expect((await terminerRetranscriptionPromo(form({ promoMaterialId: kamPmId }))).ok).toBe(true);
    ACTOR = await actorFor(u.kam);
    // §118.190 : à son propre choix des lignes, « refuser » tuait la demande au lieu de redemander des
    // devis — le refus le DIT, sans même demander de motif (l'état d'abord, §118.18).
    const propre = await refusePromoStep(form({ id: kamPmId, reason: "Budget réaffecté" }));
    expect(propre.ok ? "" : propre.error).toMatch(/C'est votre propre demande .*Redemander des devis/);
    expect((await etatDe(kamPmId)).circuitState).toBe("REVIEW_REQUESTER");
    const retenue = await prisma.promoQuoteLine.findFirstOrThrow({ where: { quote: { promoMaterialId: kamPmId } }, select: { id: true } });
    const choix = await choisirLignesPromo(form({ promoMaterialId: kamPmId, lineIds: [retenue.id], valider: "1" }));
    expect(choix.ok, choix.ok ? "" : choix.error).toBe(true);
    expect((await etatDe(kamPmId)).circuitState).toBe("REVIEW_MANAGER");
    ACTOR = await actorFor(u.dir);
    expect((await refusePromoStep(form({ id: kamPmId }))).ok).toBe(false);
    const r = await refusePromoStep(form({ id: kamPmId, reason: "Budget réaffecté" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await etatDe(kamPmId)).circuitState).toBe("REFUSED");
    ACTOR = await actorFor(u.asst);
    expect((await genererBonsDeCommandePromo(form({ promoMaterialId: kamPmId }))).ok).toBe(false);
  });

  it("SUPPRIMER UN BC d'un dossier terminé est refusé ; le motif est toujours exigé", async () => {
    const [e] = (await executionDuDossier(pmId)).filter((x) => x.bc);
    ACTOR = await actorFor(u.cp);
    const r = await annulerBonDeCommandePromo(form({ promoMaterialId: pmId, quoteId: e.quoteId, motif: "erreur" }));
    expect(r.ok).toBe(false);
  });
});
