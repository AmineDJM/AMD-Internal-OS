import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

// ⚠ ORDRE D'IMPORT (documenté dans `assistant/capability-audit.test.ts`) : `assistant` se charge le
// PREMIER, comme dans l'application — avant toute action qui, par la fabrique, remonterait le cycle
// d'initialisation `ops/index.ts` ↔ `lib/assistant.ts` par l'autre bout.
import "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { createPromoMaterial } from "./promo-material-actions";
import { validatePromoStep } from "./promo-circuit-actions";
import { demanderDevisPromo, enregistrerDevisPromo, terminerRetranscriptionPromo, choisirLignesPromo } from "./promo-devis-actions";
import { enregistrerArticleDemandePromo, retirerArticleDemandePromo } from "./promo-demande-actions";
import {
  genererBonsDeCommandePromo, deposerFacturePromo, lireFacturePromo, receptionnerLigneFacturePromo, annulerReceptionLigneFacturePromo,
  annulerFacturePromo, demanderPaiementFacturePromo, validerEtEnvoyerBcPromo,
} from "./promo-execution-actions";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";
import { signerBonDeCommande } from "./bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { executionDuDossier } from "@/lib/queries/promo-execution";
import { devisDuDossier, devisLu } from "@/lib/queries/promo-circuit";
import { articlesDemandesDuDossier } from "@/lib/queries/promo-achats";
import { gestionnairesDuMagasin } from "@/lib/queries/promo-stock";
import { rapprocher } from "@/lib/promo-material/achats";
import { verdictPaiements } from "@/lib/promo-material/execution";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { fairePartir, sousVerrou } from "@/lib/promo/stock-ecriture";
import { DELETE_REGISTRY } from "@/lib/admin-delete-registry";
import { inventorier } from "@/lib/suppression/lot";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__achats__${Date.now().toString(36)}`;

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
/** Le champ `lignes` du formulaire de création (§118.171) : une ligne, telle que l'écran l'envoie. */
const uneLigne = (catalogueId: string, quantite: string, actions: string[]) =>
  JSON.stringify([{ catalogueId, quantite, actions, produitIds: [], commentaire: "" }]);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACHATS DU MATÉRIEL PROMOTIONNEL ENTRENT AU STOCK (§118.165) — par les VRAIS points d'entrée.
 *
 * « Le demandeur pioche dans le catalogue ; l'assistante rapproche les devis de la demande et
 * génère les BC — et voire plus ; la facture renseigne exactement le matériel reçu ; le demandeur
 * coche, sur la facture en tableau, les références et quantités reçues, qui entrent au stock
 * général ; le paiement attend que tout soit reçu, sauf renoncement explicite et définitif. »
 *
 *   cp     demandeur (Direction Marketing, sans vue globale)   dir   sa directrice — tient le magasin
 *   asst   assistante de direction (retranscrit, génère)       ops   Direction des opérations (vue globale)
 *   dg     Directeur Général (centre, seuil)                    fin   Finances (signent les BC)
 *   kam    délégué — n'a rien à faire sur ce dossier            sa    Super Admin — suppléance
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — achats piochés dans le catalogue, facture ligne à ligne, réception → stock", () => {
  const u: Record<string, string> = {};
  let companyId = "", agence = "", imprimerie = "";
  let catFiche = "", catStylo = "", catEadv = "", catBloc = "", catArchive = "";
  let p1 = "", p2 = "";
  let pmId = "", autreId = "", articleAutre = "";
  const art: Record<"fiche" | "stylo" | "eadv", string> = { fiche: "", stylo: "", eadv: "" };
  let quoteA = "", quoteB = "";
  let factureB1 = "", factureA = "", factureB2 = "";
  let reference = "";

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
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("sa", "SUPER_ADMIN");
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } });
    companyId = c.id;
    // L'ORGANIGRAMME : demandeur → directrice marketing → Direction des opérations. Tous salariés
    // de la société — ce qui leur en ouvre la LECTURE, sans le droit de l'engager.
    const emp: Record<string, string> = {};
    const e = async (k: string, managerKey: string | null) => {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], managerId: managerKey ? emp[managerKey] : null, companyId } })).id;
    };
    await e("ops", null);
    await e("dir", "ops");
    await e("cp", "dir");
    await e("asst", null);
    await e("kam", "ops");
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    agence = (await prisma.companyContact.create({ data: { name: `${TAG} Agence Créa`, address: "Rue 7", city: "Alger", rc: "16/00-333", nif: "0003", companyId: null } })).id;
    imprimerie = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Atlas`, address: "Zone industrielle", city: "Alger", rc: "16/00-111", nif: "0001", companyId: null } })).id;
    const produit = async (k: string, nom: string) => (await prisma.product.create({
      data: { code: `${TAG}${k}`, canonicalName: `${TAG} ${nom}`, dci: `${TAG}${k}dci`, identityKey: `${TAG}${k}` } as never,
      select: { id: true },
    })).id;
    p1 = await produit("P1", "Nivolex");
    p2 = await produit("P2", "Trastuzex");
    const cat = async (suffixe: string, nom: string, famille: "CONSOMMABLE" | "DURABLE" | "NUMERIQUE", extra: { exigeProduit?: boolean; actif?: boolean; unite?: string } = {}) =>
      (await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}-${suffixe}`, nom: `${TAG} ${nom}`, famille, ...extra } })).id;
    catFiche = await cat("FICHE", "Fiche posologique", "CONSOMMABLE", { exigeProduit: true, unite: "pièce" });
    catStylo = await cat("STYLO", "Stylo logo", "CONSOMMABLE", { unite: "pièce" });
    catEadv = await cat("EADV", "e-ADV", "NUMERIQUE");
    catBloc = await cat("BLOC", "Bloc-notes", "CONSOMMABLE", { unite: "pièce" });
    catArchive = await cat("OLD", "Calendrier 2025", "CONSOMMABLE", { actif: false });
  }, 60_000);

  afterAll(async () => {
    const pms = await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    const pmIds = pms.map((p) => p.id);
    const pieces = (await prisma.legalDocument.findMany({ where: { OR: [{ companyId }, { sourceType: "PROMO_MATERIAL", sourceId: { in: pmIds } }] }, select: { id: true } })).map((d) => d.id);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: pieces } } }).catch(() => {});
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
    // La facture détaillée et ses lignes partent avec leur pièce (Cascade).
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: pmIds } } }).catch(() => {});
    // Les articles demandés partent avec leur dossier (Cascade) — ils retiennent le catalogue et les produits.
    await prisma.promoMaterial.deleteMany({ where: { id: { in: pmIds } } }).catch(() => {});
    // Le stock reçu : l'article emporte lots, mouvements et transferts (Cascade).
    await prisma.promoStockItem.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
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

  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!); };
  /** Le solde du magasin central (détenteur nul) pour l'article de stock d'un article du catalogue. */
  const magasin = async (catalogueId: string) => {
    const items = await prisma.promoStockItem.findMany({ where: { companyId, catalogueId }, select: { id: true } });
    if (items.length === 0) return 0;
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId: { in: items.map((i) => i.id) }, holderId: null }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const lignesDe = (legalDocumentId: string) =>
    prisma.promoFactureLigne.findMany({ where: { facture: { legalDocumentId } }, orderBy: { position: "asc" } });
  const ligne = async (legalDocumentId: string, debut: string) => {
    const l = (await lignesDe(legalDocumentId)).find((x) => x.designation.startsWith(debut));
    if (!l) throw new Error(`ligne « ${debut} » absente de la facture`);
    return l;
  };
  const devisB = async () => {
    const e = (await executionDuDossier(pmId)).find((x) => x.quoteId === quoteB);
    if (!e) throw new Error("devis de l'imprimerie absent de l'exécution");
    return e;
  };

  /**
   * FORCER UN ENTRELACEMENT (§118.65, §118.164e). Deux réceptions « en même temps » sans barrière se
   * succèdent parfois — la seconde relit APRÈS que la première a écrit et se fait refuser par la
   * lecture, pas par l'écriture conditionnelle qu'on veut éprouver. La barrière bloque les ÉCRITURES
   * de mouvements (pas leurs lectures), lance les gestes, attend qu'ils soient tous deux bloqués sur
   * le stock — donc qu'ils aient tous deux LU la ligne « à réceptionner » —, puis relâche.
   */
  async function sousBarriere<T>(lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "PromoStockMovement" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE '%PromoStock%'`;
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const vues = await tx.$queryRaw<{ etat: string | null; attente: string | null; requete: string }[]>`
            SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
            FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          throw new Error(`les gestes n'ont pas atteint la barrière (${n} en attente sur ${attendus}) — ${JSON.stringify(vues)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  it("PRÉMISSES : le demandeur n'a pas la vue globale ; la directrice tient le magasin ; l'assistante n'est pas le demandeur", async () => {
    const cp = await actorFor(u.cp!);
    expect(hasGlobalView(cp.role), "sans cela, la règle « le demandeur seul » ne se mesurerait pas").toBe(false);
    expect(hasGlobalView((await actorFor(u.asst!)).role)).toBe(false);
    expect(hasGlobalView((await actorFor(u.ops!)).role), "la Direction compose en suppléance par sa vue globale").toBe(true);
    // La directrice n'a personne de son rôle au-dessus d'elle : c'est elle qu'une entrée au magasin prévient.
    expect(await gestionnairesDuMagasin()).toContain(u.dir);
  });

  it("LA DEMANDE se pioche dans le catalogue : tout ce qui manque en une fois, et seul le demandeur (ou la Direction) la compose", async () => {
    await comme("cp");
    // LA DEMANDE NAÎT AVEC SES LIGNES (§118.171). Ce banc éprouve ensuite la COMPOSITION depuis la
    // fiche : il retire la ligne de naissance pour repartir d'une liste vide — ce que la fiche
    // permet tant que les devis ne sont pas demandés. Ni assistante, ni budget, ni entité au
    // formulaire : l'entité est celle où le demandeur travaille.
    const r = await createPromoMaterial(undefined, form({ title: `${TAG} Lancement Nivolex`, lignes: uneLigne(catBloc, "20", ["IMPRESSION"]) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    pmId = r.id!;
    const ne = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { reference: true, companyId: true, articlesDemandes: { select: { id: true } } } });
    reference = ne.reference;
    expect(ne.companyId, "l'entité du dossier est celle où travaille le demandeur").toBe(companyId);
    expect(ne.articlesDemandes).toHaveLength(1);
    expect((await retirerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: ne.articlesDemandes[0]!.id }))).ok).toBe(true);
    const autre = await createPromoMaterial(undefined, form({ title: `${TAG} Autre dossier`, lignes: uneLigne(catStylo, "50", ["ACHAT"]) }));
    expect(autre.ok, autre.ok ? "" : autre.error).toBe(true);
    autreId = autre.id!;
    articleAutre = (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: autreId }, select: { id: true } })).id;

    // QUI : ni l'assistante, ni un délégué étranger au dossier.
    await comme("asst");
    const asst = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catStylo, quantite: "10", actions: ["ACHAT"] }));
    expect(asst.ok).toBe(false);
    expect(asst.ok ? "" : asst.error).toMatch(/Seul le demandeur \(ou la Direction\)/);
    await comme("kam");
    expect((await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catStylo, quantite: "10", actions: ["ACHAT"] }))).ok).toBe(false);

    // TOUT CE QUI MANQUE, EN UNE FOIS (§118.18) : produit d'une fiche ET action attendue.
    await comme("cp");
    const deux = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catFiche, quantite: "5000" }));
    expect(deux.ok).toBe(false);
    expect(deux.ok ? "" : deux.error).toMatch(/produits concernés.*au moins une action/s);
    const numQte = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catEadv, quantite: "10", actions: ["CONCEPTION"] }));
    expect(numQte.ok ? "" : numQte.error).toMatch(/support NUMÉRIQUE.*laissez-la vide/s);
    const illisible = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catStylo, quantite: "mille", actions: ["ACHAT"] }));
    expect(illisible.ok ? "" : illisible.error).toMatch(/quantité lisible/);
    const archive = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catArchive, quantite: "10", actions: ["ACHAT"] }));
    expect(archive.ok ? "" : archive.error).toMatch(/archivé/);
    const inconnue = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catStylo, quantite: "10", actions: ["TELEPORTATION"] }));
    expect(inconnue.ok ? "" : inconnue.error).toMatch(/Action inconnue/);
    expect(await prisma.promoRequestItem.count({ where: { promoMaterialId: pmId } }), "aucun refus n'a rien écrit").toBe(0);

    // LES TROIS FAMILLES : une fiche par produit (deux produits, puis corrigée à un), des stylos, un e-ADV.
    const fiche = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catFiche, produitIds: [p1, p2], quantite: "5 000", actions: ["CONCEPTION", "IMPRESSION"], commentaire: "Recto-verso, A5" }));
    expect(fiche.ok, fiche.ok ? "" : fiche.error).toBe(true);
    art.fiche = fiche.id!;
    const corrige = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: art.fiche, catalogueId: catFiche, produitIds: [p1], quantite: "5000", actions: ["CONCEPTION", "IMPRESSION"], commentaire: "Recto-verso, A5" }));
    expect(corrige.ok, corrige.ok ? "" : corrige.error).toBe(true);
    const produits = await prisma.promoRequestItemProduct.findMany({ where: { itemId: art.fiche }, select: { productId: true } });
    expect(produits.map((p) => p.productId), "les produits se REMPLACENT : une correction ne garde pas le produit retiré").toEqual([p1]);
    const stylo = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catStylo, quantite: "1000", actions: ["ACHAT"] }));
    expect(stylo.ok, stylo.ok ? "" : stylo.error).toBe(true);
    art.stylo = stylo.id!;
    // La Direction compose en suppléance (la règle de `demandeLesDevis`, la même que pour demander les devis).
    await comme("ops");
    const eadv = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catEadv, actions: ["CONCEPTION"] }));
    expect(eadv.ok, eadv.ok ? "" : eadv.error).toBe(true);
    art.eadv = eadv.id!;

    // RETIRER, et l'article d'un AUTRE dossier ne se corrige ni ne se retire d'ici.
    await comme("cp");
    const tmp = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catBloc, quantite: "20", actions: ["IMPRESSION"] }));
    expect(tmp.ok).toBe(true);
    expect((await retirerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: tmp.id! }))).ok).toBe(true);
    const vole = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: articleAutre, catalogueId: catStylo, quantite: "1", actions: ["ACHAT"] }));
    expect(vole.ok ? "" : vole.error).toMatch(/n'appartient pas à ce dossier/);
    expect((await retirerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: articleAutre }))).ok).toBe(false);
    expect(await prisma.promoRequestItem.findUnique({ where: { id: articleAutre } })).not.toBeNull();
    expect((await prisma.promoRequestItem.findUniqueOrThrow({ where: { id: articleAutre } })).quantite?.toNumber(), "l'article de l'autre dossier n'a pas bougé").toBe(50);

    // UN ARTICLE DU CATALOGUE COMMANDÉ ne se supprime pas : la base le retient (Restrict), et le refus
    // le DIT avant l'erreur brute — sur l'e-ADV, demandé mais pas encore reçu au stock.
    expect(await prisma.promoStockItem.count({ where: { catalogueId: catEadv } }), "prémisse : aucun stock ne le cite encore").toBe(0);
    expect(await DELETE_REGISTRY.PROMO_CATALOGUE.refuse!(catEadv)).toMatch(/1 demande\(s\) d'achat de matériel promotionnel le commandent/);
    expect(await DELETE_REGISTRY.PROMO_CATALOGUE.refuse!(catArchive), "un article jamais commandé ni stocké se supprime").toBeNull();

    const lus = await articlesDemandesDuDossier(pmId);
    expect(lus.map((x) => [x.reference, x.quantite, x.actions])).toEqual([
      [`${TAG}-FICHE`, 5000, ["CONCEPTION", "IMPRESSION"]],
      [`${TAG}-STYLO`, 1000, ["ACHAT"]],
      [`${TAG}-EADV`, null, ["CONCEPTION"]],
    ]);
  }, 60_000);

  it("UNE FOIS LES DEVIS DEMANDÉS, la liste bouge encore — et l'assistante est prévenue de chaque changement (§118.190)", async () => {
    await comme("dir");
    const v = await validatePromoStep(form({ id: pmId }));
    expect(v.ok, v.ok ? "" : v.error).toBe(true);

    // LA CARTE D'ADAM NE PROMET PAS CE QUE L'ACTION REFUSERAIT (§118.83) : sans article, elle n'offre
    // pas la demande de devis ; avec, elle montre ce qui partira chez l'assistante. Une demande naît
    // avec ses lignes (§118.171), mais la fiche peut toutes les retirer avant les devis : la garde
    // reste donc nécessaire, et c'est par ce chemin qu'un dossier y arrive vide.
    await comme("cp");
    const vide = await createPromoMaterial(undefined, form({ title: `${TAG} Sans article`, lignes: uneLigne(catBloc, "20", ["IMPRESSION"]) }));
    expect(vide.ok, vide.ok ? "" : vide.error).toBe(true);
    const ligneDuVide = await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: vide.id! }, select: { id: true } });
    expect((await retirerArticleDemandePromo(form({ promoMaterialId: vide.id!, requestItemId: ligneDuVide.id }))).ok).toBe(true);
    await comme("dir");
    expect((await validatePromoStep(form({ id: vide.id! }))).ok).toBe(true);
    const cp = await actorFor(u.cp!);
    const refVide = (await prisma.promoMaterial.findUniqueOrThrow({ where: { id: vide.id! }, select: { reference: true } })).reference;
    const sansArticle = await DOMAIN_TOOLS.promo_operation.ops.request_promo_quotes.impl.propose({ reference: refVide }, cp);
    expect("error" in sansArticle && sansArticle.error).toMatch(/aucun article demandé.*catalogue/);
    // SANS ARTICLE, LA DEMANDE DE DEVIS AUTOMATIQUE N'EST PAS PARTIE (§118.204) : le dossier reste sur « devis à
    // demander », et c'est le seul cas où la carte (et le geste de repli) servent encore.
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: vide.id! }, select: { circuitState: true } })).circuitState).toBe("QUOTE_TO_REQUEST");

    // LA DEMANDE DE DEVIS EST PARTIE D'ELLE-MÊME À LA VALIDATION (§118.204) — sans geste du demandeur, avec
    // les articles de la liste, dans la rédaction que l'aperçu montrait.
    const envoye = await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { circuitState: true, adminRequestId: true } });
    expect(envoye.circuitState).toBe("QUOTE_REQUESTED");
    const demandeAuto = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: envoye.adminRequestId! }, select: { type: true, description: true, linkedEntityId: true } });
    expect(demandeAuto.type).toBe("QUOTE");
    expect(demandeAuto.linkedEntityId).toBe(pmId);
    expect(demandeAuto.description).toMatch(new RegExp(`${TAG}-FICHE[\\s\\S]*${TAG}-STYLO[\\s\\S]*${TAG}-EADV`));
    // Le geste de repli refuse alors, en le DISANT : la demande ne repart pas une seconde fois.
    await comme("cp");
    const r = await demanderDevisPromo(form({ promoMaterialId: pmId }));
    expect(r.ok ? "" : r.error).toMatch(/déjà partie/);
    // La règle d'avant figeait la liste dès les devis demandés : l'article oublié n'était jamais chiffré,
    // ou l'était hors de la liste. Elle bouge maintenant tant que le choix n'est pas en validation, et
    // l'assistante, qui cherche les devis, est prévenue de CHAQUE changement — ajouté puis retiré ici,
    // la liste revient à ce qui a été demandé pour la suite du banc.
    const ajout = await enregistrerArticleDemandePromo(form({ promoMaterialId: pmId, catalogueId: catBloc, quantite: "20", actions: ["IMPRESSION"] }));
    expect(ajout.ok, ajout.ok ? "" : ajout.error).toBe(true);
    expect(ajout.message).toMatch(/L'assistante en est prévenue\.$/);
    const retrait = await retirerArticleDemandePromo(form({ promoMaterialId: pmId, requestItemId: ajout.id! }));
    expect(retrait.ok, retrait.ok ? "" : retrait.error).toBe(true);
    expect(await prisma.notification.count({ where: { userId: u.asst!, link: `/promo-material/${pmId}`, title: { startsWith: "Matériel promotionnel — un article demandé" } } })).toBe(2);
    expect(await prisma.promoRequestItem.count({ where: { promoMaterialId: pmId } })).toBe(3);
  });

  it("LE RAPPROCHEMENT : chaque ligne porte son action, ne chiffre que les articles de SON dossier, et « en plus » est permis", async () => {
    await comme("asst");
    const etrangere = form({
      promoMaterialId: pmId, supplierId: imprimerie, ligneReference: ["Stylo"], ligneQuantite: ["10"], lignePrix: ["50"], ligneAction: ["ACHAT"], ligneArticle: [articleAutre],
    });
    etrangere.set("scan", pdf("x.pdf"));
    const refus = await enregistrerDevisPromo(etrangere);
    expect(refus.ok ? "" : refus.error).toMatch(/pas demandé sur ce dossier/);

    const fdA = form({
      promoMaterialId: pmId, supplierId: agence, reference: "AC-2026-09", tvaRate: "19", announcedTotal: "350000",
      ligneReference: ["Conception fiche posologique Nivolex", "Conception e-ADV Nivolex"], ligneUnite: ["forfait", "forfait"],
      ligneQuantite: ["1", "1"], lignePrix: ["150000", "200000"], ligneAction: ["CONCEPTION", "CONCEPTION"], ligneArticle: [art.fiche, art.eadv],
    });
    fdA.set("scan", pdf("devis-agence.pdf"));
    const a = await enregistrerDevisPromo(fdA);
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    quoteA = a.id!;
    const fdB = form({
      promoMaterialId: pmId, supplierId: imprimerie, reference: "IA-114", tvaRate: "19", announcedTotal: "170000",
      ligneReference: ["Fiche posologique Nivolex", "Stylo logo", "Bloc-notes logo"], ligneUnite: ["pièce", "pièce", "pièce"],
      ligneQuantite: ["5000", "1000", "200"], lignePrix: ["20", "50", "100"], ligneAction: ["IMPRESSION", "ACHAT", "IMPRESSION"],
      ligneArticle: [art.fiche, art.stylo, ""],
    });
    fdB.set("scan", pdf("devis-imprimerie.pdf"));
    const b = await enregistrerDevisPromo(fdB);
    expect(b.ok, b.ok ? "" : b.error).toBe(true);
    quoteB = b.id!;

    // Ce que l'assistante fait de tête, posé sous les yeux : la fiche est chiffrée DEUX fois (conception
    // chez l'agence, impression chez l'imprimeur), aucune action demandée n'est restée sans devis, et le
    // bloc-notes est « en plus ».
    const rap = rapprocher(await articlesDemandesDuDossier(pmId), (await devisDuDossier(pmId)).map(devisLu));
    const fiche = rap.articles.find((x) => x.article.id === art.fiche)!;
    expect(fiche.lignes.map((l) => [l.fournisseur.replace(`${TAG} `, ""), l.action])).toEqual([["Agence Créa", "CONCEPTION"], ["Imprimerie Atlas", "IMPRESSION"]]);
    expect(rap.articles.every((x) => x.actionsSansDevis.length === 0)).toBe(true);
    expect(rap.sansDevis).toEqual([]);
    expect(rap.enPlus.map((l) => l.reference)).toEqual(["Bloc-notes logo"]);

    const fin = await terminerRetranscriptionPromo(form({ promoMaterialId: pmId }));
    expect(fin.ok, fin.ok ? "" : fin.error).toBe(true);
  });

  it("JUSQU'AUX BC SIGNÉS : le demandeur retient tout (« et voire plus »), les validations passent, la plateforme génère — l'action devant chaque ligne", async () => {
    const lignes = await prisma.promoQuoteLine.findMany({ where: { quote: { promoMaterialId: pmId } }, select: { id: true } });
    await comme("cp");
    const choix = await choisirLignesPromo(form({ promoMaterialId: pmId, lineIds: lignes.map((l) => l.id), valider: "1" }));
    expect(choix.ok, choix.ok ? "" : choix.error).toBe(true);
    await comme("dir");
    const dm = await validatePromoStep(form({ id: pmId }));
    expect(dm.ok, dm.ok ? "" : dm.error).toBe(true);
    // 416 500 (agence) + 202 300 (imprimerie) = 618 800 TTC : le DG seulement si le seuil est plus bas.
    const seuil = (await getAppSettings()).adProDgThreshold ?? 0;
    if (seuil > 0 && 618_800 > seuil) {
      await comme("dg");
      const g = await validatePromoStep(form({ id: pmId }));
      expect(g.ok, g.ok ? "" : g.error).toBe(true);
    }
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: pmId }, select: { circuitState: true } })).circuitState).toBe("IN_EXECUTION");

    await comme("asst");
    const gen = await genererBonsDeCommandePromo(form({ promoMaterialId: pmId }));
    expect(gen.ok, gen.ok ? "" : gen.error).toBe(true);
    // L'APERÇU D'ABORD (Direction, 10/2026) : rien n'est émis tant que le demandeur ne l'a pas validé.
    expect((await executionDuDossier(pmId)).filter((e) => e.bc)).toHaveLength(0);
    await comme("cp");
    for (const quoteId of [quoteA, quoteB]) {
      const v = await validerEtEnvoyerBcPromo(form({ promoMaterialId: pmId, quoteId }));
      expect(v.ok, v.ok ? "" : v.error).toBe(true);
    }
    const execution = await executionDuDossier(pmId);
    expect(execution.filter((e) => e.bc)).toHaveLength(2);
    // LE BC DIT CE QU'ON COMMANDE au fournisseur : l'action devant la désignation du devis.
    const bcB = execution.find((e) => e.quoteId === quoteB)!.bc!;
    const spec = ((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcB.id }, select: { custom: true } })).custom as { fabrique: { spec: { lignes: { designation: string }[] } } }).fabrique.spec;
    expect(spec.lignes.map((l) => l.designation)).toEqual(["Impression — Fiche posologique Nivolex", "Achat — Stylo logo", "Impression — Bloc-notes logo"]);
    const bcA = execution.find((e) => e.quoteId === quoteA)!.bc!;
    const specA = ((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcA.id }, select: { custom: true } })).custom as { fabrique: { spec: { lignes: { designation: string }[] } } }).fabrique.spec;
    expect(specA.lignes.map((l) => l.designation), "« Conception … » ne se répète pas").toEqual(["Conception fiche posologique Nivolex", "Conception e-ADV Nivolex"]);

    for (const e of execution.filter((x) => x.bc)) {
      if ((await etatDuBC(e.bc!.id))?.etape === "A_VALIDER") {
        await comme("dg");
        const visa = await deciderVisaCentreAdPro(form({ entityType: "LEGAL_DOCUMENT", entityId: e.bc!.id, approve: "1" }));
        expect(visa.ok, visa.ok ? "" : visa.error).toBe(true);
      }
      await comme("fin");
      const s = await signerBonDeCommande(avecCopieSignee(form({ id: e.bc!.id })));
      expect(s.ok, s.ok ? "" : s.error).toBe(true);
    }
  }, 180_000);

  it("LA FACTURE : les lignes du BC, jamais plus que commandé ; le total IMPRIMÉ contrôle la saisie ; les écarts se DISENT", async () => {
    const e = await devisB();
    expect(e.lignesBC.map((l) => [l.designation, l.quantite, l.dejaFacture])).toEqual([
      ["Fiche posologique Nivolex", 5000, 0], ["Stylo logo", 1000, 0], ["Bloc-notes logo", 200, 0],
    ]);
    const ids = e.lignesBC.map((l) => l.quoteLineId);
    const facture = (q: string[], p: string[], champs: Record<string, string>) => {
      const fd = form({ promoMaterialId: pmId, quoteId: quoteB, ligneQuoteLineId: ids, ligneQuantite: q, lignePrix: p, ...champs });
      fd.set("file", pdf("facture.pdf"));
      return deposerFacturePromo(fd);
    };
    await comme("cp");
    const trop = await facture(["6000", "1000", "200"], ["20", "50", "100"], { reference: "IA-F1", amount: "202300" });
    expect(trop.ok ? "" : trop.error).toMatch(/« Fiche posologique Nivolex » : 6\s000 facturées pour 5\s000 restant.*on ne facture pas plus que commandé/s);
    const mauvaisTotal = await facture(["5000", "1000", "200"], ["20", "50", "100"], { reference: "IA-F1", amount: "999" });
    expect(mauvaisTotal.ok ? "" : mauvaisTotal.error).toMatch(/la facture annonce/);
    expect(await prisma.legalDocument.count({ where: { kind: "INVOICE", chainFromId: e.bc!.id } }), "aucun refus n'a laissé de pièce").toBe(0);

    // PARTIELLE : 4 000 fiches facturées sur 5 000 commandées. HT 80 000 + 50 000 + 20 000 = 150 000 → 178 500 TTC.
    const r = await facture(["4000", "1000", "200"], ["20", "50", "100"], { reference: "IA-F1", amount: "178500", invoiceDate: "2026-09-28" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    factureB1 = r.id!;
    expect(r.message ?? "").toMatch(/Écarts avec le BC : « Fiche posologique Nivolex » : 4\s000 facturées sur 5\s000 restant au BC/);
    const detail = await prisma.promoFacture.findUniqueOrThrow({ where: { legalDocumentId: factureB1 }, select: { tvaRate: true, totalImprime: true, quoteId: true } });
    expect([Number(detail.tvaRate), Number(detail.totalImprime), detail.quoteId]).toEqual([19, 178_500, quoteB]);
    expect((await lignesDe(factureB1)).map((l) => [l.designation, Number(l.quantite), l.action, Boolean(l.requestItemId)])).toEqual([
      ["Fiche posologique Nivolex", 4000, "IMPRESSION", true], ["Stylo logo", 1000, "ACHAT", true], ["Bloc-notes logo", 200, "IMPRESSION", false],
    ]);
    // Le reste à facturer suit la facture : 1 000 fiches, rien d'autre.
    expect((await devisB()).lignesBC.map((l) => l.quantite - l.dejaFacture)).toEqual([1000, 0, 0]);
    // LE VERDICT DIT LE GESTE ATTENDU : cocher ce qui est arrivé, pas « demander le paiement ».
    const verdict = verdictPaiements(await executionDuDossier(pmId));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.raison).toMatch(/IA-F1.*3 lignes à réceptionner/);

    // LES CARTES D'ADAM disent la même règle AVANT le clic : une facture déposée de la conversation
    // reprend ce qui reste (1 000 fiches → 23 800 TTC) ; le paiement attend la réception.
    const cp = await actorFor(u.cp!);
    await prisma.driveNode.create({ data: { name: `${TAG}-facture-ia-f2.pdf`, type: "FILE", ownerId: u.cp, size: 8, mimeType: "application/pdf" } });
    const fausse = await DOMAIN_TOOLS.promo_operation.ops.deposit_promo_invoice.impl.propose({ reference, supplier: "Imprimerie", invoiceRef: "IA-F2", amount: "30000", file: `${TAG}-facture-ia-f2` }, cp);
    expect("error" in fausse && fausse.error).toMatch(/fait 23\s800,00 DZD TTC, la facture annonce 30\s000,00 DZD.*se détaille ligne à ligne depuis la fiche/s);
    const juste = await DOMAIN_TOOLS.promo_operation.ops.deposit_promo_invoice.impl.propose({ reference, supplier: "Imprimerie", invoiceRef: "IA-F2", amount: "23800", file: `${TAG}-facture-ia-f2` }, cp);
    expect("error" in juste ? juste.error : "").toBe("");
    const paiement = await DOMAIN_TOOLS.promo_operation.ops.request_promo_invoice_payment.impl.propose({ reference, invoiceRef: "IA-F1", mode: "visa" }, cp);
    expect("error" in paiement && paiement.error).toMatch(/3 lignes de la facture IA-F1 attendent leur réception/);

    // SANS LIGNES SAISIES (un appel qui ne les détaille pas) : la facture reprend ce qui reste sur le BC.
    const fdA = form({ promoMaterialId: pmId, quoteId: quoteA, reference: "AC-F1", amount: "416500" });
    fdA.set("file", pdf("facture-agence.pdf"));
    const fa = await deposerFacturePromo(fdA);
    expect(fa.ok, fa.ok ? "" : fa.error).toBe(true);
    factureA = fa.id!;
    expect((await lignesDe(factureA)).map((l) => [l.designation, Number(l.quantite), Number(l.prixUnitaire)])).toEqual([
      ["Conception fiche posologique Nivolex", 1, 150_000], ["Conception e-ADV Nivolex", 1, 200_000],
    ]);
  }, 60_000);

  it("LA RÉCEPTION : le demandeur coche ce qui est arrivé — un lot au magasin, au coût de la facture, la directrice prévenue ; jamais deux fois", async () => {
    const fiche = await ligne(factureB1, "Fiche");
    for (const k of ["asst", "ops", "kam"]) {
      await comme(k);
      const refus = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: fiche.id }));
      expect(refus.ok ? "" : refus.error, `${k} n'atteste pas la réception`).toMatch(/se coche par le demandeur du dossier/);
    }
    await comme("cp");
    const plus = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: fiche.id, quantiteRecue: "4001" }));
    expect(plus.ok ? "" : plus.error).toMatch(/plus que la facture/);
    const r = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: fiche.id, quantiteRecue: "3900", valableJusquau: "2027-12-31" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message ?? "").toMatch(/\+3\s900 .*entrés au magasin central.*100 facturées ne sont pas arrivées/s);
    const relue = await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: fiche.id }, include: { stockLot: true, stockItem: { include: { produits: true } } } });
    expect(Number(relue.quantiteRecue)).toBe(3900);
    expect(relue.recueParId).toBe(u.cp);
    expect(relue.stockLot).toMatchObject({ origine: "ACHAT", itemId: relue.stockItemId });
    expect(Number(relue.stockLot!.coutUnitaire)).toBe(20);
    expect(relue.stockLot!.valableJusquau?.toISOString().slice(0, 10)).toBe("2027-12-31");
    // L'article de stock est celui de l'article DEMANDÉ : la fiche, pour SON produit.
    expect(relue.stockItem).toMatchObject({ companyId, catalogueId: catFiche });
    expect(relue.stockItem!.produits.map((p) => p.productId)).toEqual([p1]);
    expect(await magasin(catFiche)).toBe(3900);
    expect(await prisma.notification.count({ where: { userId: u.dir, link: CHEMIN_STOCK_PROMO, body: { contains: `(${reference},` } } }), "la directrice apprend ce qui entre — c'est elle qui dote").toBe(1);

    const encore = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: fiche.id }));
    expect(encore.ok ? "" : encore.error).toMatch(/déjà réceptionnée/);
    expect(await prisma.promoStockLot.count({ where: { factureLignes: { some: { id: fiche.id } } } })).toBe(1);
    // UNE LIGNE REÇUE A FAIT ENTRER DU MATÉRIEL : la corbeille refuse d'effacer le dossier qui en est
    // la cause (§118.162) — le lot resterait au magasin, sans plus aucune facture pour le justifier.
    const inv = await inventorier("PromoMaterial", pmId);
    expect(inv?.bloquants.join(" ")).toMatch(/a été reçu au magasin/);
  }, 60_000);

  it("RÉCEPTION CONCURRENTE : deux clics qui ont tous deux lu la ligne « à réceptionner » ne font qu'UN lot", async () => {
    const stylo = await ligne(factureB1, "Stylo");
    const cp = await actorFor(u.cp!);
    ACTOR = cp;
    const [r1, r2] = await sousBarriere(() => [
      receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id })),
      receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id })),
    ]);
    const resultats = [r1!, r2!];
    expect(resultats.filter((x) => x.ok), JSON.stringify(resultats)).toHaveLength(1);
    expect(resultats.find((x) => !x.ok)?.error).toMatch(/vient d'être réceptionnée/);
    const items = await prisma.promoStockItem.findMany({ where: { companyId, catalogueId: catStylo }, select: { id: true } });
    expect(await prisma.promoStockLot.count({ where: { itemId: { in: items.map((i) => i.id) } } })).toBe(1);
    expect(await magasin(catStylo)).toBe(1000);
  }, 60_000);

  it("« EN PLUS » : une ligne que personne n'a demandée choisit son article — le Super Admin coche en suppléance", async () => {
    const bloc = await ligne(factureB1, "Bloc");
    await comme("cp");
    const sansArticle = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: bloc.id }));
    expect(sansArticle.ok ? "" : sansArticle.error).toMatch(/n'était pas demandée : choisissez l'article du catalogue/);
    const archive = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: bloc.id, catalogueId: catArchive }));
    expect(archive.ok ? "" : archive.error).toMatch(/archivé/);
    expect(await prisma.promoStockItem.count({ where: { companyId, catalogueId: { in: [catBloc, catArchive] } } }), "un refus ne crée aucun article de stock").toBe(0);
    await comme("sa");
    const r = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: bloc.id, catalogueId: catBloc }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await magasin(catBloc)).toBe(200);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: pmId, actorId: u.sa, summary: { contains: "Bloc-notes logo" } }, select: { summary: true } });
    expect(trace?.summary).toMatch(/en suppléance du demandeur/);
  }, 60_000);

  it("UNE PRESTATION est cochée « faite », rien n'entre au stock ; la CONCEPTION d'un support numérique pose son lien", async () => {
    await comme("cp");
    const conception = await ligne(factureA, "Conception fiche");
    const avant = await prisma.promoStockLot.count({ where: { item: { companyId } } });
    const r = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: conception.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message ?? "").toMatch(/prestation : rien n'entre au stock/);
    const relue = await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: conception.id } });
    expect([Number(relue.quantiteRecue), relue.stockItemId, relue.stockLotId]).toEqual([1, null, null]);
    expect(await prisma.promoStockLot.count({ where: { item: { companyId } } })).toBe(avant);

    const eadv = await ligne(factureA, "Conception e-ADV");
    const illisible = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: eadv.id, lien: "https://cdn.t.dz/eadv-nivolex", valableJusquau: "fin juin" }));
    expect(illisible.ok ? "" : illisible.error).toMatch(/illisible/);
    const n = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: eadv.id, lien: "https://cdn.t.dz/eadv-nivolex", valableJusquau: "2027-06-30" }));
    expect(n.ok, n.ok ? "" : n.error).toBe(true);
    const support = await prisma.promoStockItem.findFirstOrThrow({ where: { companyId, catalogueId: catEadv }, include: { lots: true } });
    expect(support.lien).toBe("https://cdn.t.dz/eadv-nivolex");
    expect(support.valableJusquau?.toISOString().slice(0, 10)).toBe("2027-06-30");
    expect(support.lots, "un support numérique n'a rien à compter").toHaveLength(0);
    expect((await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: eadv.id } })).stockItemId).toBe(support.id);
  });

  it("ANNULER UNE RÉCEPTION : son entrée est contre-passée — refusé quand une partie est déjà sortie du magasin", async () => {
    const fiche = await ligne(factureB1, "Fiche");
    // 300 fiches partent chez un délégué : elles ne sont plus au magasin.
    const sortie = await sousVerrou(fiche.stockItemId!, (tx) => fairePartir(tx, fiche.stockItemId!, {
      nature: "DOTATION", deId: null, versId: u.kam!, quantite: 300, note: "banc", initiateurId: u.dir!, maintenant: new Date(),
    }));
    expect("ok" in sortie && sortie.ok, JSON.stringify(sortie)).toBe(true);
    await comme("cp");
    const refus = await annulerReceptionLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: fiche.id, motif: "erreur de saisie" }));
    expect(refus.ok ? "" : refus.error).toMatch(/creuserait le lot sous zéro/);
    expect(Number((await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: fiche.id } })).quantiteRecue)).toBe(3900);

    const stylo = await ligne(factureB1, "Stylo");
    await comme("asst");
    expect((await annulerReceptionLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id }))).ok, "l'assistante ne défait pas l'attestation du demandeur").toBe(false);
    await comme("cp");
    // SANS MOTIF, rien ne se défait (audit 360°, R17) — et la ligne reste reçue, son entrée au magasin intacte.
    const muet = await annulerReceptionLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id }));
    expect(muet.ok ? "" : muet.error).toMatch(/Dites pourquoi cette réception est annulée/);
    expect(await prisma.promoStockMovement.count({ where: { lotId: stylo.stockLotId!, kind: "REVERSAL" } })).toBe(0);
    const ok = await annulerReceptionLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id, motif: "carton compté deux fois" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(await magasin(catStylo)).toBe(0);
    expect(await prisma.promoStockMovement.count({ where: { lotId: stylo.stockLotId!, kind: "REVERSAL" } })).toBe(1);
    const remise = await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: stylo.id } });
    expect([remise.quantiteRecue, remise.stockLotId, remise.recueParId]).toEqual([null, null, null]);
    // Recochée juste : un nouveau lot, l'ancien reste au registre — rien ne s'efface.
    const re = await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id, quantiteRecue: "1000" }));
    expect(re.ok, re.ok ? "" : re.error).toBe(true);
    expect(await magasin(catStylo)).toBe(1000);
    expect(await prisma.promoStockLot.count({ where: { item: { companyId, catalogueId: catStylo } } })).toBe(2);
  }, 60_000);

  it("LE PAIEMENT attend la réception ; y renoncer est explicite, écrit et définitif ; on paie ce qui est REÇU", async () => {
    await comme("cp");
    const attente = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB1, formalite: "AD_VISA" }));
    expect(attente.ok).toBe(false);
    expect(attente.ok ? "" : attente.error).toMatch(/« Fiche posologique Nivolex » \(3\s900 reçues sur 4\s000\).*ne pourra pas être fait ultérieurement/s);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: factureB1 } })).toBe(0);

    // RENONCER SANS DIRE POURQUOI ne part pas — et rien n'est écrit : ni ligne renoncée, ni ordre (§118.18 :
    // le motif est demandé APRÈS les refus structurels, AVANT tout effet).
    const sansMotif = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB1, formalite: "AD_VISA", confirmeRenoncement: "1" }));
    expect(sansMotif.ok ? "" : sansMotif.error).toMatch(/Dites pourquoi vous renoncez aux lignes non reçues/);
    expect(await prisma.promoFactureLigne.count({ where: { facture: { legalDocumentId: factureB1 }, renonce: true } })).toBe(0);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: factureB1 } })).toBe(0);

    const r = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB1, formalite: "AD_VISA", confirmeRenoncement: "1", motifRenoncement: "Carton abîmé à la livraison" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message ?? "").toMatch(/la part reçue.*1 ligne non livrée : renoncement enregistré/s);
    // 3 900 × 20 + 1 000 × 50 + 200 × 100 = 148 000 HT → 176 120 TTC — pas les 178 500 facturés.
    const ordre = await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: factureB1 } });
    expect(Number(ordre.amount)).toBe(176_120);
    expect(ordre.label).toMatch(/part reçue/);
    expect(ordre.centralStatus).toBe("AWAITING");
    const fiche = await ligne(factureB1, "Fiche");
    expect([fiche.renonce, fiche.renonceMotif, fiche.renonceParId]).toEqual([true, "Carton abîmé à la livraison", u.cp]);
    const decl = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { sourceType_sourceId: { sourceType: "LEGAL_DOCUMENT", sourceId: factureB1 } } });
    expect([decl.declarationKind, decl.amount]).toEqual(["AD_VISA", null]);

    // LA RÉCEPTION EST CLOSE : on ne coche plus, on ne défait plus, ce qu'on a demandé à payer.
    const stylo = await ligne(factureB1, "Stylo");
    expect((await annulerReceptionLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: stylo.id }))).error).toMatch(/paiement de cette facture est déjà demandé/);
    expect((await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: fiche.id, quantiteRecue: "100" }))).error).toMatch(/paiement de cette facture est déjà demandé/);

    // TOUT REÇU (une prestation, un support numérique) : on paie le total IMPRIMÉ.
    const a = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureA, formalite: "MIP" }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    expect(Number((await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: factureA } })).amount)).toBe(416_500);
  }, 60_000);

  it("LIRE LA FACTURE (lot D2-F) : la lecture ne s'écrit nulle part, et un dépôt qui la désigne exige qu'elle existe pour CE fichier", async () => {
    await comme("cp");
    // Le juge compte les factures des devis de CE dossier : un compte sur toute la base partagée mesure le voisinage — un autre
    // fichier de la suite qui nettoie ses factures pendant la lecture suffisait à le faire tomber (3 → 2), sans rien défaire ici.
    const avant = await prisma.promoFacture.count({ where: { quote: { promoMaterialId: pmId } } });
    expect((await lireFacturePromo(form({ promoMaterialId: pmId, quoteId: quoteB }))).error).toMatch(/Choisissez le fichier/);
    const lu = form({ promoMaterialId: pmId, quoteId: quoteB });
    lu.set("file", pdf("f3.pdf"));
    const r = await lireFacturePromo(lu);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.lecture?.lectureId).toBeTruthy();
    expect(await prisma.promoFacture.count({ where: { quote: { promoMaterialId: pmId } } }), "lire n'écrit aucune facture").toBe(avant);
    const forge = form({ promoMaterialId: pmId, quoteId: quoteB, reference: "IA-F3", amount: "1", lectureId: "inexistante", totalVerifie: "on" });
    forge.set("file", pdf("f3.pdf"));
    expect((await deposerFacturePromo(forge)).error).toMatch(/lecture désignée n'existe pas/);
    const sansTotal = form({ promoMaterialId: pmId, quoteId: quoteB, reference: "IA-F3", amount: "1", lectureId: r.lecture!.lectureId });
    sansTotal.set("file", pdf("f3.pdf"));
    expect((await deposerFacturePromo(sansTotal)).error).toMatch(/total vérifié/);
    expect(await prisma.promoFacture.count({ where: { quote: { promoMaterialId: pmId } } }), "un refus n'écrit rien").toBe(avant);
    // CONFIRMÉE : la ligne saisie à la main, le total coché — la facture s'inscrit ET porte sa confirmation.
    const fiche = (await devisB()).lignesBC.find((l) => l.designation.startsWith("Fiche"))!;
    const conf = form({ promoMaterialId: pmId, quoteId: quoteB, reference: "IA-F3", amount: "2380", lectureId: r.lecture!.lectureId, totalVerifie: "on",
      ligneQuoteLineId: [fiche.quoteLineId], ligneQuantite: ["100"], lignePrix: ["20"] });
    conf.set("file", pdf("f3.pdf"));
    const d = await deposerFacturePromo(conf);
    expect(d.ok, d.ok ? "" : d.error).toBe(true);
    const c = await prisma.lecturePieceConfirmation.findFirst({ where: { cibleType: "PROMO_FACTURE", cibleId: d.id! } });
    expect(c?.lectureId, "la confirmation est consignée sur la facture déposée").toBe(r.lecture!.lectureId);
    // Défaite : le scénario qui suit compte sur les 1 000 restantes.
    expect((await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: d.id!, motif: "banc D2-F" }))).ok).toBe(true);
  });

  it("LE RENONCEMENT NE REVIENT PAS : la quantité renoncée reste facturée, elle ne se refacture pas", async () => {
    const e = await devisB();
    const fiche = e.lignesBC.find((l) => l.designation.startsWith("Fiche"))!;
    expect(fiche.quantite - fiche.dejaFacture, "5 000 commandées, 4 000 facturées (dont 100 renoncées) — il en reste 1 000, pas 1 100").toBe(1000);
    await comme("cp");
    const trop = form({ promoMaterialId: pmId, quoteId: quoteB, reference: "IA-F2", amount: "26180", ligneQuoteLineId: [fiche.quoteLineId], ligneQuantite: ["1100"], lignePrix: ["20"] });
    trop.set("file", pdf("f2.pdf"));
    expect((await deposerFacturePromo(trop)).error).toMatch(/1\s100 facturées pour 1\s000 restant/);
    const ok = form({ promoMaterialId: pmId, quoteId: quoteB, reference: "IA-F2", amount: "23800", ligneQuoteLineId: [fiche.quoteLineId], ligneQuantite: ["1000"], lignePrix: ["20"] });
    ok.set("file", pdf("f2.pdf"));
    const r = await deposerFacturePromo(ok);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    factureB2 = r.id!;
  });

  it("ANNULER UNE FACTURE : un motif, jamais après le paiement, jamais avec une ligne reçue — et ses lignes redeviennent à facturer", async () => {
    await comme("cp");
    expect((await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB1, motif: "doublon" }))).error).toMatch(/paiement de cette facture est déjà demandé/);
    expect((await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB2 }))).error).toMatch(/Dites pourquoi/);
    const l = (await lignesDe(factureB2))[0]!;
    expect((await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: l.id }))).ok).toBe(true);
    // SANS motif ici, exprès : l'état d'abord (§118.18) — une facture qui ne s'annule pas d'ici ne demande pas pourquoi.
    expect((await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB2 }))).error).toMatch(/réceptionnées : annulez d'abord leur réception/);
    expect((await annulerReceptionLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: l.id, motif: "coche erronée" }))).ok).toBe(true);
    const r = await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: factureB2, motif: "facture refaite" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureB2 }, select: { status: true, cancelReason: true } });
    expect(doc).toEqual({ status: "CANCELLED", cancelReason: "facture refaite" });
    const fiche = (await devisB()).lignesBC.find((x) => x.designation.startsWith("Fiche"))!;
    expect(fiche.quantite - fiche.dejaFacture, "une facture annulée ne retient plus rien").toBe(1000);
    // Elle ne se réceptionne plus : ses lignes ne sont plus celles d'une facture du dossier.
    expect((await receptionnerLigneFacturePromo(form({ promoMaterialId: pmId, ligneId: l.id }))).error).toMatch(/n'appartient pas à une facture de ce dossier/);
  }, 60_000);

  it("UNE FACTURE D'AVANT LE DÉTAIL ligne à ligne se paie comme avant : son montant, sans réception", async () => {
    const bc = (await devisB()).bc!;
    const ancienne = await prisma.legalDocument.create({
      data: {
        companyId, kind: "INVOICE", reference: "IA-ANCIENNE", title: `Facture IA-ANCIENNE — ${TAG} Imprimerie Atlas (${reference})`,
        counterparty: `${TAG} Imprimerie Atlas`, amount: 20_000, chainFromId: bc.id, sourceType: "PROMO_MATERIAL", sourceId: pmId,
        createdById: u.cp, updatedById: u.cp,
      },
    });
    const lue = (await devisB()).factures.find((f) => f.id === ancienne.id)!;
    expect([lue.detail, lue.receptionAttendue]).toEqual([null, 0]);
    await comme("cp");
    const r = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: ancienne.id, formalite: "AD_VISA" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(Number((await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: ancienne.id } })).amount)).toBe(20_000);
  });
  it("UNE FACTURE REFUSÉE AU CENTRE se renvoie et s'annule depuis le dossier ; celle dont l'ordre attend, non (§118.185, I8)", async () => {
    await comme("cp");
    const ancienne = await prisma.legalDocument.findFirstOrThrow({ where: { reference: "IA-ANCIENNE", sourceId: pmId }, select: { id: true, expenseOrderId: true } });
    // Le témoin : l'ordre ATTEND le centre — la facture ne repart pas, et ne s'annule pas d'ici.
    const doublon = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: ancienne.id, formalite: "AD_VISA" }));
    expect(doublon.ok ? "" : doublon.error).toMatch(/déjà partie au règlement/);
    expect((await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: ancienne.id, motif: "x" }))).error).toMatch(/paiement de cette facture est déjà demandé/);
    // Le centre REFUSE : l'ordre ne paiera jamais — la facture repart, et l'ancien ordre est fermé.
    await prisma.expenseOrder.update({ where: { id: ancienne.expenseOrderId! }, data: { centralStatus: "REFUSED" } });
    const r = await demanderPaiementFacturePromo(form({ promoMaterialId: pmId, invoiceId: ancienne.id, formalite: "AD_VISA" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ancienne.expenseOrderId! } })).status).toBe("CANCELLED");
    const nouvelOrdre = (await prisma.legalDocument.findUniqueOrThrow({ where: { id: ancienne.id }, select: { expenseOrderId: true } })).expenseOrderId!;
    expect(nouvelOrdre).not.toBe(ancienne.expenseOrderId);
    // Refusé à son tour : la facture s'annule d'ici, et emporte l'ordre refusé.
    await prisma.expenseOrder.update({ where: { id: nouvelOrdre }, data: { centralStatus: "REFUSED" } });
    const a = await annulerFacturePromo(form({ promoMaterialId: pmId, invoiceId: ancienne.id, motif: "fournisseur changé" }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: nouvelOrdre } })).status).toBe("CANCELLED");
  }, 60_000);
});
