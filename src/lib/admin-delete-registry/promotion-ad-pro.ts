/**
 * Registre des suppressions — les entrées : la déclaration d'information médicale, le matériel, le catalogue et le stock promotionnels,
 * le poste Ad & Pro, les prises en charge (congrès international et national).
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { prisma } from "@/lib/prisma";
import type { DeletableKind, KindSpec } from "./types";

export const REGISTRE_PROMOTION_AD_PRO = {
  MEDICAL_INFO_DECLARATION: {
    label: "déclaration d'information médicale",
    module: "Information médicale",
    redirect: "/information-medicale",
    model: "medicalInfoDeclaration",
    entityType: "MEDICAL_INFO_DECLARATION",
    lot: true,
    searchFields: ["reference", "label"],
    async describe(id) {
      const r = await prisma.medicalInfoDeclaration.findUnique({ where: { id }, select: { reference: true, label: true } });
      return r ? `${r.reference} — ${r.label}` : null;
    },
    async remove(id) {
      await prisma.medicalInfoDeclaration.delete({ where: { id } });
    },
  },
  PROMO_MATERIAL: {
    label: "dossier de matériel promotionnel",
    module: "Matériel promotionnel",
    redirect: "/promo-material",
    model: "promoMaterial",
    entityType: "PROMO_MATERIAL",
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.promoMaterial.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.promoMaterial.delete({ where: { id } });
    },
  },
  // LE CATALOGUE PROMOTIONNEL (§118.164) — « le super administrateur peut supprimer ». Un article qui
  // a SERVI ne se supprime pas : des stocks le citent et leur historique en dépend ; il s'ARCHIVE
  // (`archiverArticleCatalogue`), reste lisible là où il a servi, et ne se propose plus. Le refus le
  // dit AVANT le clic, et nomme le geste qui le remplace (§118.83).
  PROMO_CATALOGUE: {
    label: "article du catalogue promotionnel",
    module: "Catalogue promotionnel",
    redirect: CHEMIN_CATALOGUE_PROMO,
    model: "promoCatalogueArticle",
    searchFields: ["reference", "nom"],
    async describe(id) {
      const r = await prisma.promoCatalogueArticle.findUnique({ where: { id }, select: { reference: true, nom: true } });
      return r ? `${r.reference} — ${r.nom}` : null;
    },
    // DEUX LECTEURS, et les deux retiennent (§118.165) : un article de stock, ET un article DEMANDÉ
    // sur un dossier d'achat (la clé étrangère est en Restrict). Sans le second, la suppression d'un
    // article demandé mais jamais reçu tombait sur l'erreur brute de la base — « des éléments liés
    // bloquent », un diagnostic qui ne nomme rien.
    async refuse(id) {
      const [stock, demandes] = await Promise.all([
        prisma.promoStockItem.count({ where: { catalogueId: id } }),
        prisma.promoRequestItem.count({ where: { catalogueId: id } }),
      ]);
      const usages = [
        ...(stock > 0 ? [`${stock} article(s) de stock le citent`] : []),
        ...(demandes > 0 ? [`${demandes} demande(s) d'achat de matériel promotionnel le commandent`] : []),
      ];
      return usages.length
        ? `Cet article a servi : ${usages.join(", et ")} — leur historique en dépend. Archivez-le plutôt : il ne se proposera plus, et restera lisible là où il a servi.`
        : null;
    },
    async remove(id) {
      await prisma.promoCatalogueArticle.delete({ where: { id } });
    },
  },
  // UN ARTICLE DE STOCK (§118.164) — seulement s'il n'a JAMAIS bougé (un support numérique déclaré
  // par erreur, un article créé sans entrée). Un article qui a un mouvement porte une histoire :
  // on l'archive, on ne l'efface pas — l'écran d'avant supprimait l'article ET son historique.
  PROMO_STOCK_ITEM: {
    label: "article de stock promotionnel",
    module: "Stock promotionnel",
    redirect: CHEMIN_STOCK_PROMO,
    model: "promoStockItem",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.promoStockItem.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async refuse(id) {
      // UN SUPPORT NUMÉRIQUE N'A PAS DE MOUVEMENT, mais il a été PRÉSENTÉ en visite (§118.166) :
      // l'effacer retirerait la ligne de l'historique des médecins — la base le refuserait de
      // toute façon (clé étrangère RESTRICT), et le refus doit dire pourquoi au lieu d'échouer.
      const [mouvements, demandes, presentations] = await Promise.all([
        prisma.promoStockMovement.count({ where: { itemId: id } }),
        prisma.promoStockRequest.count({ where: { itemId: id } }),
        prisma.medicalVisitSupportNumerique.count({ where: { itemId: id } }),
      ]);
      return mouvements > 0 || demandes > 0 || presentations > 0
        ? `Cet article a une histoire (${mouvements} mouvement(s), ${demandes} demande(s)${presentations ? `, ${presentations} présentation(s) en visite` : ""}) : on ne l'efface pas. Archivez-le depuis sa fiche une fois son stock à zéro.`
        : null;
    },
    async remove(id) {
      await prisma.promoStockItem.delete({ where: { id } });
    },
  },
  // UN POSTE D'UNE DEMANDE AD & PRO (§118.187, audit 360° R11) — « Retirer le poste » l'effaçait
  // définitivement, hors corbeille, avec l'historique de ses décisions en cascade. Il part désormais
  // en LOT : ses décisions, ses voyageurs, ses pièces, ses demandes au secrétariat, le BC non signé
  // qu'elles ont fait naître, et son ordre de dépense non réglé (`LIENS_DIRECTS`) — et il revient avec
  // eux. Il ne refuse rien LUI-MÊME : un ordre réglé, du matériel du stock dehors ou une pièce signée
  // parmi ses branches bloquent par le LOT (`faitIrreversible`), comme pour l'appel d'offres PCH. Une
  // seconde copie de ces règles ici finirait par ne pas refuser la même chose (§118.5).
  AD_PRO_ITEM: {
    label: "poste d'une demande Ad & Pro",
    module: "Ad & Pro",
    redirect: "/ad-pro",
    model: "adProItem",
    entityType: "AD_PRO_ITEM",
    lot: true,
    searchFields: ["label"],
    async describe(id) {
      const r = await prisma.adProItem.findUnique({ where: { id }, select: { label: true } });
      return r ? r.label : null;
    },
    async remove(id) {
      await prisma.adProItem.delete({ where: { id } });
    },
  },
  CONGRESS_INTERNATIONAL: {
    label: "demande de congrès international",
    module: "Prises en charge Internationales",
    redirect: "/congress-international",
    model: "congressInternational",
    entityType: "CONGRESS_INTERNATIONAL",
    lot: true,
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.congressInternational.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.congressInternational.delete({ where: { id } });
    },
  },
  CONGRESS_NATIONAL: {
    label: "demande d'événement national",
    module: "Prises en charge Nationales",
    redirect: "/congress-national",
    model: "congressNational",
    entityType: "CONGRESS_NATIONAL",
    lot: true,
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.congressNational.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.congressNational.delete({ where: { id } });
    },
  },
} satisfies Partial<Record<DeletableKind, KindSpec>>;
