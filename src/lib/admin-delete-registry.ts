import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { refusSuppressionRapport } from "@/lib/promo/remises-visite";
import { refusSuppressionDeLaPiece } from "@/lib/queries/suppression-piece";
import { refusSuppressionDemandePaiement } from "@/lib/queries/demande-paiement-suppression";
import { refusSuppressionCommandePch, refusSuppressionLotDeMarche, refusSuppressionPraticien } from "@/lib/queries/suppression-refus";
import { retirerEnAttente } from "@/lib/bons-de-commande/aiguillage";
import { inventorier } from "@/lib/suppression/lot";
import { resumeDesLiens } from "@/lib/suppression/branches";

/**
 * LE REGISTRE des suppressions définitives — la source de vérité UNIQUE, partagée par :
 *   • les actions serveur de l'écran (`admin-delete-actions.ts` : bouton rouge des fiches,
 *     corbeille, suppression par le créateur) ;
 *   • le Chief of Staff (`assistant.ts` : outil `delete_record`), qui PROPOSE la même
 *     suppression et l'exécute via `superAdminDelete` — jamais une deuxième logique.
 *
 * Il vit hors du fichier `"use server"` parce qu'un module d'actions ne peut exporter que des
 * fonctions async — or l'assistant a besoin de la LISTE des types, de leurs libellés et de leurs
 * champs de recherche pour résoudre « supprime REG-2026-041 » sans dupliquer quoi que ce soit.
 */

/** Types d'enregistrements que le Super Admin peut supprimer définitivement. */
export type DeletableKind =
  | "PCH_ORDER"
  | "REGULATORY_PRODUCT"
  | "SPONSORING"
  | "EVENT"
  | "EMPLOYEE"
  | "HR_REQUEST"
  | "LEAVE_REQUEST"
  | "DOSSIER"
  | "ADMIN_REQUEST"
  | "MEETING"
  | "FIELD_REPORT"
  | "SALE"
  | "DOCTOR"
  | "BD_OPPORTUNITY"
  | "BD_PROJECT"
  | "DIRECTIVE"
  | "SUPPORT_REQUEST"
  | "FINANCE_TRANSACTION"
  | "EXPENSE_ORDER"
  | "PAYMENT_REQUEST"
  | "SUPPLIER"
  | "MEDICAL_INFO_DECLARATION"
  | "PROMO_MATERIAL"
  | "CONGRESS_INTERNATIONAL"
  | "CONGRESS_NATIONAL"
  | "VALIDATION_REQUEST"
  | "MAIL_ENTRY"
  | "LEGAL_DOCUMENT"
  | "CONVERSATION"
  | "NOTIFICATION"
  | "CONSULTING_CONTRACT"
  | "AD_PRO_OTHER"
  | "PROMO_CATALOGUE"
  | "PROMO_STOCK_ITEM"
  | "AD_PRO_ITEM"
  | "PCH_TENDER"
  | "PCH_TENDER_LINE"
  | "DRIVE_NODE";

export interface KindSpec {
  label: string; // libellé du type (« dossier réglementaire »)
  module: string; // module pour le journal d'audit
  redirect: string; // liste où l'élément disparaît après suppression
  entityType?: EntityType; // pour nettoyer Documents + Commentaires polymorphes
  /** Nom du délégué Prisma (snapshot avant suppression + restauration générique). */
  model: string;
  describe: (id: string) => Promise<string | null>; // nom lisible, ou null si introuvable
  remove: (id: string) => Promise<void>; // suppression de la ligne principale
  /**
   * CE QUE LA RESTAURATION NE RENDRA PAS — dit dans la PHRASE, pas dans un champ JSON.
   *
   * La corbeille instantane la ligne PRINCIPALE ; ce qui part en cascade ne revient pas. La
   * réserve générique (« les lignes liées en cascade ne sont pas restaurables ») est vraie et
   * illisible : pour un groupe de messagerie, la cascade EST le contenu — membres et
   * historique — donc « restaurable » sans cette phrase promet un retour qui n'aura pas lieu
   * (§104.16). Lu par l'écran d'administration ET par la carte de confirmation d'Adam : deux
   * rédactions de la même réserve finiraient par dire deux choses différentes (§118.5).
   *
   * Absent = la restauration rend l'élément tel qu'il était (le cas courant).
   */
  reserve?: string;
  /**
   * CE QUE CE TYPE REFUSE DE SUPPRIMER, et POURQUOI — évalué avant tout instantané.
   *
   * Sans lui, un refus légitime n'avait que deux sorties, toutes deux fausses : `describe`
   * rendant `null` dit « introuvable » d'un objet parfaitement présent, et une exception dans
   * `remove` est avalée par « des éléments liés bloquent. Détachez-les puis réessayez » — un
   * diagnostic inventé, sur un geste qu'aucun détachement ne débloquera. Le refus vit donc
   * ICI, dans le cœur partagé, donc il vaut pour l'écran ET pour Adam (§118.71).
   *
   * Rend `null` quand il n'y a rien à refuser. Absent = ce type ne refuse rien (le cas courant).
   */
  refuse?: (id: string) => Promise<string | null>;
  /**
   * L'identifiant du créateur, quand ce type peut être supprimé par SON créateur (et pas
   * seulement par le Super Admin). Absent = suppression réservée au Super Admin.
   */
  creatorOf?: (id: string) => Promise<string | null>;
  /**
   * Champs TEXTE sur lesquels une RÉFÉRENCE HUMAINE se cherche (« REG-2026-041 », un nom,
   * un titre) — pour que l'assistant résolve l'élément sans demander l'id interne.
   * Absent = ce type ne se désigne que par id (ex. demande RH, composite sans référence).
   */
  searchFields?: string[];
  /**
   * CE QUE LA SUPPRESSION A COMPENSÉ AILLEURS, à refaire en sens inverse à la restauration.
   *
   * La corbeille recrée la ligne telle quelle — elle ne sait rien des compteurs qu'elle
   * alimentait. Un congé accordé avait débité un solde de jours ; sa suppression les restitue
   * (voir LEAVE_REQUEST) ; sans ce crochet, le restaurer rendrait le congé ET les jours, et
   * personne ne saurait d'où vient l'écart. Absent = rien à compenser (le cas courant).
   */
  restored?: (id: string) => Promise<void>;
  /**
   * CETTE LIGNE EMPORTE SES BRANCHES (§118.162) — sa déclaration d'information médicale, ses
   * demandes au secrétariat, son circuit, ses visas, ses pièces au registre, ses postes… tout ce
   * qui n'existe que pour elle part dans le MÊME lot de corbeille et revient avec lui. Et elle
   * refuse de partir quand une branche porte un fait qui a quitté l'ERP (règlement, signature,
   * déclaration aux autorités, courrier inscrit). Voir `lib/suppression/`.
   *
   * Absent = l'ancien comportement : la ligne seule, ses pièces et ses commentaires.
   */
  lot?: boolean;
}

export const DELETE_REGISTRY: Record<DeletableKind, KindSpec> = {
  REGULATORY_PRODUCT: {
    label: "dossier réglementaire",
    module: "Regulatory",
    redirect: "/regulatory",
    model: "regulatoryProduct",
    entityType: "REGULATORY_PRODUCT",
    searchFields: ["reference", "dci"],
    async describe(id) {
      const r = await prisma.regulatoryProduct.findUnique({ where: { id }, select: { reference: true, dci: true } });
      return r ? `${r.reference} — ${r.dci}` : null;
    },
    async remove(id) {
      await prisma.regulatoryProduct.delete({ where: { id } });
    },
  },
  SPONSORING: {
    label: "demande de congrès / sponsoring",
    module: "Sponsoring",
    redirect: "/sponsoring",
    model: "sponsoringRequest",
    entityType: "SPONSORING",
    lot: true,
    searchFields: ["reference", "institution"],
    async describe(id) {
      const r = await prisma.sponsoringRequest.findUnique({ where: { id }, select: { reference: true, institution: true } });
      return r ? `${r.reference} — ${r.institution}` : null;
    },
    async remove(id) {
      await prisma.sponsoringRequest.delete({ where: { id } });
    },
  },
  EVENT: {
    label: "événement",
    module: "Événements",
    redirect: "/events",
    model: "event",
    // Il manquait : les pièces jointes et commentaires d'un événement supprimé restaient en base,
    // rattachés à rien — et la restauration ne les rendait pas.
    entityType: "EVENT",
    lot: true,
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.event.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.event.delete({ where: { id } });
    },
  },
  EMPLOYEE: {
    label: "employé",
    module: "RH",
    redirect: "/rh",
    model: "employee",
    entityType: "EMPLOYEE",
    searchFields: ["fullName"],
    async describe(id) {
      const r = await prisma.employee.findUnique({ where: { id }, select: { fullName: true } });
      return r ? r.fullName : null;
    },
    async remove(id) {
      await prisma.employee.delete({ where: { id } });
    },
  },
  /**
   * UNE DEMANDE DE CONGÉ — jamais l'employé, jamais son solde par accident.
   *
   * Supprimer une demande ACCORDÉE, c'est effacer une ligne qui a déjà débité le compteur de
   * jours : si l'on se contentait du `delete`, la personne perdrait ses jours pour une demande
   * qui n'existe plus, et personne ne saurait retrouver pourquoi. On RESTITUE donc le solde
   * dans le même geste — et seulement pour ce qui l'avait entamé (congé annuel accordé).
   */
  LEAVE_REQUEST: {
    label: "demande de congé",
    module: "RH",
    redirect: "/rh/conges",
    model: "leaveRequest",
    entityType: "LEAVE_REQUEST",
    searchFields: ["reason"],
    async describe(id) {
      const r = await prisma.leaveRequest.findUnique({
        where: { id },
        select: { startDate: true, endDate: true, days: true, employee: { select: { fullName: true } } },
      });
      if (!r) return null;
      const p = `${r.startDate.toLocaleDateString("fr-FR")} → ${r.endDate.toLocaleDateString("fr-FR")}`;
      return `${r.employee.fullName} — ${p} (${Number(r.days)} j)`;
    },
    async remove(id) {
      const r = await prisma.leaveRequest.findUnique({
        where: { id },
        select: { employeeId: true, days: true, type: true, status: true },
      });
      if (!r) return;
      await prisma.$transaction(async (tx) => {
        if (r.status === "APPROVED" && r.type === "ANNUAL") {
          await tx.employee.update({
            where: { id: r.employeeId },
            data: { leaveBalanceDays: { increment: Number(r.days) } },
          });
        }
        await tx.leaveRequest.delete({ where: { id } });
      });
    },
    /** Restaurer un congé accordé, c'est le rendre — donc reprendre les jours restitués. */
    async restored(id) {
      const r = await prisma.leaveRequest.findUnique({
        where: { id },
        select: { employeeId: true, days: true, type: true, status: true },
      });
      if (!r || r.status !== "APPROVED" || r.type !== "ANNUAL") return;
      await prisma.employee.update({
        where: { id: r.employeeId },
        data: { leaveBalanceDays: { decrement: Number(r.days) } },
      });
    },
  },
  // Une SEULE demande RH (attestation, note de frais, entrevue…) — jamais l'employé.
  HR_REQUEST: {
    label: "demande RH",
    module: "RH",
    redirect: "/rh",
    model: "hrDocumentRequest",
    entityType: "HR_REQUEST",
    async describe(id) {
      const r = await prisma.hrDocumentRequest.findUnique({
        where: { id },
        select: { type: true, employee: { select: { fullName: true } } },
      });
      return r ? `Demande ${r.type} — ${r.employee.fullName}` : null;
    },
    async remove(id) {
      // Une demande de congé annuel APPROUVÉE a débité le solde (verrou balanceAppliedAt) :
      // la supprimer rend les jours — même geste que LEAVE_REQUEST, même raison.
      const r = await prisma.hrDocumentRequest.findUnique({
        where: { id },
        select: { employeeId: true, balanceAppliedAt: true, periodDays: true },
      });
      if (!r) return;
      const jours = r.balanceAppliedAt && Number(r.periodDays ?? 0) > 0 ? Number(r.periodDays) : 0;
      await prisma.$transaction(async (tx) => {
        if (jours > 0) {
          await tx.employee.update({ where: { id: r.employeeId }, data: { leaveBalanceDays: { increment: jours } } });
        }
        await tx.hrDocumentRequest.delete({ where: { id } });
      });
    },
    /** Restaurer une demande dont le solde avait été rendu = reprendre les jours restitués. */
    async restored(id) {
      const r = await prisma.hrDocumentRequest.findUnique({
        where: { id },
        select: { employeeId: true, balanceAppliedAt: true, periodDays: true },
      });
      if (!r || !r.balanceAppliedAt || !(Number(r.periodDays ?? 0) > 0)) return;
      await prisma.employee.update({
        where: { id: r.employeeId },
        data: { leaveBalanceDays: { decrement: Number(r.periodDays) } },
      });
    },
  },
  DOSSIER: {
    label: "sujet",
    module: "Sujets",
    redirect: "/dossiers",
    model: "dossier",
    entityType: "DOSSIER",
    searchFields: ["title"],
    async describe(id) {
      const r = await prisma.dossier.findUnique({ where: { id }, select: { title: true } });
      return r ? r.title : null;
    },
    async remove(id) {
      await prisma.dossier.delete({ where: { id } });
    },
  },
  ADMIN_REQUEST: {
    label: "demande administrative",
    module: "Demandes",
    redirect: "/demandes",
    model: "administrativeRequest",
    entityType: "ADMIN_REQUEST",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.administrativeRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.administrativeRequest.delete({ where: { id } });
    },
  },
  MEETING: {
    label: "réunion",
    module: "Réunions",
    redirect: "/meetings",
    model: "meeting",
    searchFields: ["title"],
    async describe(id) {
      const r = await prisma.meeting.findUnique({ where: { id }, select: { title: true } });
      return r ? r.title : null;
    },
    async remove(id) {
      await prisma.meeting.delete({ where: { id } });
    },
  },
  FIELD_REPORT: {
    label: "rapport terrain",
    module: "Promotion médicale",
    redirect: CHEMIN_RAPPORTS_TERRAIN,
    model: "fieldReport",
    searchFields: ["doctorName", "institution"],
    async describe(id) {
      const r = await prisma.fieldReport.findUnique({ where: { id }, select: { doctorName: true, institution: true, visitDate: true, delegate: { select: { name: true } } } });
      // L'auteur est dans le nom : la corbeille liste des rapports de tout le monde, et « Médecin non
      // précisé — 05/10/2026 » ne dit pas lequel restaurer (§118.212).
      return r ? `${r.doctorName || r.institution || "Rapport"} — ${r.visitDate.toLocaleDateString("fr-FR")}${r.delegate?.name ? ` (${r.delegate.name})` : ""}` : null;
    },
    // Le MÊME refus que l'action de suppression (§118.204) : un compte rendu qui porte du matériel
    // remis justifie des sorties du stock, il ne passe pas à la corbeille. Et, depuis §118.212, un
    // compte rendu qui est le seul rapport d'une visite de l'emploi du temps.
    refuse: (id) => refusSuppressionRapport(id),
    // UN LOT (§118.212) : le rapport ET ses pièces jointes (`FieldReportAttachment`, supprimées en
    // cascade par la base) partent ensemble et reviennent ensemble. Avant, la restauration rendait
    // le rapport SANS ses pièces — alors que la phrase de la corbeille disait « restaurable ». Les
    // fichiers (pièces, audio) restent au stockage tant que l'entrée existe : seule la destruction
    // réelle depuis la corbeille les libère.
    lot: true,
    async remove(id) {
      await prisma.fieldReport.delete({ where: { id } });
    },
  },
  SALE: {
    label: "vente",
    module: "Ventes",
    redirect: "/sales/historique",
    model: "sale",
    entityType: "SALE",
    searchFields: ["product", "client"],
    async describe(id) {
      const r = await prisma.sale.findUnique({ where: { id }, select: { product: true, client: true } });
      return r ? `${r.product} — ${r.client}` : null;
    },
    async remove(id) {
      await prisma.sale.delete({ where: { id } });
    },
  },
  DOCTOR: {
    label: "médecin",
    module: "Médical",
    redirect: "/medical/annuaire",
    model: "medicalDoctor",
    entityType: "DOCTOR",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.medicalDoctor.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    refuse: refusSuppressionPraticien,
    // UN LOT (DONNEES-07) : segmentation, observations, couleurs de cellule partent et reviennent avec la fiche.
    lot: true,
    async remove(id) {
      await prisma.medicalDoctor.delete({ where: { id } });
    },
  },
  BD_OPPORTUNITY: {
    label: "opportunité (Business Development)",
    module: "Business Development",
    redirect: "/business-development",
    model: "businessDevelopmentOpportunity",
    entityType: "BD_OPPORTUNITY",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.businessDevelopmentOpportunity.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.businessDevelopmentOpportunity.delete({ where: { id } });
    },
  },
  BD_PROJECT: {
    label: "projet",
    module: "Projets",
    // L'écran « Projets » (module `BD_PROJECTS`, §118.163) — et non plus la racine de Market
    // Intelligence, retirée : un retour après suppression vers une page qui ne s'ouvre pas.
    redirect: "/business-development/projets",
    model: "bdProject",
    entityType: "BD_PROJECT",
    // Ses gammes et ses produits partent en cascade, et chaque dossier réglementaire classé perd
    // son projet : un lot les instantane tous, et tout revient ensemble à la restauration.
    lot: true,
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.bdProject.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.bdProject.delete({ where: { id } });
    },
  },
  DIRECTIVE: {
    label: "directive",
    module: "Directives",
    redirect: "/directives",
    model: "directive",
    entityType: "DIRECTIVE",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.directive.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.directive.delete({ where: { id } });
    },
  },
  SUPPORT_REQUEST: {
    label: "demande de support",
    module: "Support",
    redirect: "/support",
    model: "supportRequest",
    entityType: "SUPPORT_REQUEST",
    searchFields: ["reference", "subject"],
    async describe(id) {
      const r = await prisma.supportRequest.findUnique({ where: { id }, select: { reference: true, subject: true } });
      return r ? `${r.reference} — ${r.subject}` : null;
    },
    async remove(id) {
      await prisma.supportRequest.delete({ where: { id } });
    },
  },
  FINANCE_TRANSACTION: {
    label: "écriture comptable",
    module: "Finances",
    redirect: "/finances",
    model: "financeTransaction",
    entityType: "FINANCE_TRANSACTION",
    searchFields: ["reference", "label"],
    async describe(id) {
      const r = await prisma.financeTransaction.findUnique({ where: { id }, select: { reference: true, label: true } });
      return r ? `${r.reference} — ${r.label}` : null;
    },
    async remove(id) {
      await prisma.financeTransaction.delete({ where: { id } });
    },
    // UN LOT (§118.176) — « supprime carrément ça, une ou plusieurs » (Direction, 01/10, sur les
    // écritures « à imputer »). Supprimée seule, une écriture laissait derrière elle ce qui la
    // CITE : la facture qu'elle règle (clé mise à vide, jamais rétablie à la restauration), l'ordre
    // de dépense, la dotation de caisse ou le bulletin qui la nomment par un champ texte (qui
    // désignaient alors une écriture disparue). En lot, ces liens sont vidés ensemble, NOMMÉS
    // avant le clic (« ce qui reste mais perd son lien »), et rétablis si on la restaure.
    lot: true,
  },
  EXPENSE_ORDER: {
    label: "ordre de dépense",
    module: "Finances",
    redirect: "/finances/paiements-a-faire",
    model: "expenseOrder",
    entityType: "EXPENSE_ORDER",
    searchFields: ["reference", "label"],
    async describe(id) {
      const r = await prisma.expenseOrder.findUnique({ where: { id }, select: { reference: true, label: true } });
      return r ? `${r.reference} — ${r.label}` : null;
    },
    async remove(id) {
      await prisma.expenseOrder.delete({ where: { id } });
    },
  },
  /**
   * UNE DEMANDE DE PAIEMENT RETIRÉE (Direction, 19/10/2026) — elle part EN LOT : son ordre de dépense annulé (sinon une
   * ligne orpheline au registre des ordres), ses pièces et son fil, et tout revient ensemble à la restauration. Le
   * refus (`refusDeSuppression`) garde le dossier vivant, le compagnon et tout paiement déjà sorti.
   */
  PAYMENT_REQUEST: {
    label: "demande de paiement",
    module: "Demandes de paiement",
    redirect: "/validations/paiements",
    model: "paymentRequest",
    entityType: "PAYMENT_REQUEST",
    searchFields: ["reference", "title"],
    refuse: (id) => refusSuppressionDemandePaiement(id),
    async describe(id) {
      const r = await prisma.paymentRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async creatorOf(id) {
      const r = await prisma.paymentRequest.findUnique({ where: { id }, select: { requesterId: true } });
      return r?.requesterId ?? null;
    },
    async remove(id) {
      await prisma.paymentRequest.delete({ where: { id } });
    },
    lot: true,
  },
  SUPPLIER: {
    label: "fournisseur",
    module: "Administration",
    redirect: "/admin/suppliers",
    model: "supplier",
    entityType: "SUPPLIER",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.supplier.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.supplier.delete({ where: { id } });
    },
  },
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
  PCH_TENDER: {
    label: "appel d'offres",
    module: "PCH",
    redirect: "/pch",
    model: "pchTender",
    entityType: "PCH_TENDER",
    // Ses lots, ses bons de commande, leurs lignes et leurs livraisons partaient en CASCADE, sans
    // corbeille (audit 360°, I17) : un clic effaçait des mois de suivi de marché. Le lot les instantane
    // tous, et tout revient ensemble à la restauration (§118.162) ; ce qui a quitté l'ERP refuse.
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.pchTender.findUnique({ where: { id }, select: { title: true, reference: true } });
      return r ? `${r.reference}${r.title ? ` — ${r.title}` : ""}` : null;
    },
    async remove(id) {
      await prisma.pchTender.delete({ where: { id } });
    },
  },
  PCH_ORDER: {
    label: "bon de commande de marché",
    module: "PCH",
    redirect: "/pch",
    model: "pchOrder",
    entityType: "PCH_ORDER",
    refuse: refusSuppressionCommandePch,
    // UN LOT (DONNEES-15) : lignes et livraisons attendues partent et reviennent avec lui (avant : un `delete` nu).
    lot: true,
    async describe(id) {
      const r = await prisma.pchOrder.findUnique({ where: { id }, select: { reference: true, tender: { select: { reference: true } } } });
      return r ? `${r.reference ?? "Bon de commande"} — marché ${r.tender.reference}` : null;
    },
    async remove(id) {
      await prisma.pchOrder.delete({ where: { id } });
    },
  },
  PCH_TENDER_LINE: {
    label: "lot d'appel d'offres",
    module: "PCH",
    redirect: "/pch",
    model: "pchTenderLine",
    // SANS type d'entité : un lot n'a ni pièces jointes ni commentaires à lui — ils vivent sur son marché.
    // Il partait d'un seul `delete`, sans corbeille ni journal (vague « restes ») ; le lot instantane la
    // ligne et ses affectations à des BU, et tout revient ensemble à la restauration (§118.162).
    lot: true,
    searchFields: ["designation"],
    async describe(id) {
      const r = await prisma.pchTenderLine.findUnique({ where: { id }, select: { designation: true, tender: { select: { reference: true } } } });
      return r ? `${r.designation} — ${r.tender.reference}` : null;
    },
    refuse: refusSuppressionLotDeMarche,
    async remove(id) {
      await prisma.pchTenderLine.delete({ where: { id } });
    },
  },
  VALIDATION_REQUEST: {
    label: "demande de validation",
    module: "Validations",
    redirect: "/validations",
    model: "validationRequest",
    entityType: "VALIDATION_REQUEST",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.validationRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.validationRequest.delete({ where: { id } });
    },
  },
  MAIL_ENTRY: {
    label: "courrier",
    module: "Courriers",
    redirect: "/courriers",
    model: "mailEntry",
    entityType: "MAIL_ENTRY",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.mailEntry.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? (r.reference ? `${r.reference} — ${r.title}` : r.title) : null;
    },
    async creatorOf(id) {
      const r = await prisma.mailEntry.findUnique({ where: { id }, select: { createdById: true } });
      return r?.createdById ?? null;
    },
    async remove(id) {
      await prisma.mailEntry.delete({ where: { id } });
    },
  },
  LEGAL_DOCUMENT: {
    label: "document légal",
    module: "Legal",
    redirect: "/legal",
    model: "legalDocument",
    entityType: "LEGAL_DOCUMENT",
    searchFields: ["reference", "title"],
    // CE QUI NE SE SUPPRIME PAS (§118.209) : une pièce signée, réglée, partie au règlement, validée par un
    // centre, ou dont une autre pièce découle. Le refus vit chez l'ÉCRIVAIN : la fiche Legal, la demande
    // Ad & Pro et la corbeille du Super Admin passent par ici, et deux règles finiraient par ne pas refuser
    // la même chose (§118.106). Il NOMME le geste qui reste (annuler, supprimer l'aval d'abord…).
    refuse: (id) => refusSuppressionDeLaPiece(id),
    async describe(id) {
      const r = await prisma.legalDocument.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? (r.reference ? `${r.reference} — ${r.title}` : r.title) : null;
    },
    async creatorOf(id) {
      const r = await prisma.legalDocument.findUnique({ where: { id }, select: { createdById: true } });
      return r?.createdById ?? null;
    },
    async remove(id) {
      // Une validation qui attend au centre sur une pièce qui n'existe plus serait un arbitrage à rendre sur
      // rien : la porte part avec le bon de commande (la fiche Legal ne la retirait pas, l'action d'Adam si).
      // APRÈS la suppression de la ligne : la porte est désignée par un couple (type, identifiant) que rien ne
      // lie par clé étrangère — si la suppression refuse (lien bloquant), la porte reste, la pièce aussi.
      await prisma.legalDocument.delete({ where: { id } });
      await retirerEnAttente(id);
    },
  },

  /**
   * UN CONTRAT DE CONSULTING et UNE « AUTRE DEMANDE » Ad & Pro — les deux natures du pôle qui
   * n'avaient AUCUNE suppression (§118.162). « Toute demande est liée du début à la fin à ses
   * branches » ne pouvait pas valoir pour cinq natures sur sept : elles passent par le même lot.
   */
  CONSULTING_CONTRACT: {
    label: "contrat de consulting",
    module: "Consulting",
    redirect: "/consulting",
    model: "consultingContract",
    entityType: "CONSULTING_CONTRACT",
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.consultingContract.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.consultingContract.delete({ where: { id } });
    },
  },
  AD_PRO_OTHER: {
    label: "autre demande Ad & Pro",
    module: "Ad & Pro",
    redirect: "/ad-pro/autres",
    model: "adProOtherRequest",
    entityType: "AD_PRO_OTHER",
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.adProOtherRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.adProOtherRequest.delete({ where: { id } });
    },
  },

  /**
   * UN GROUPE ou UN CANAL de la messagerie interne — jamais un tête-à-tête.
   *
   * « Supprimer un groupe » n'existait pas : la messagerie ne savait qu'ARCHIVER, et l'archive
   * laisse la conversation vivante pour ses membres. Le geste passe donc par le patron canonique
   * (instantané → corbeille → restaurable → audité), comme les 26 autres types.
   *
   * CE QUE LA RESTAURATION REND, et c'est la moitié qui compte : la ligne PRINCIPALE seule.
   * `ConversationMember` et `Message` partent en CASCADE et ne sont pas instantanés — restaurer
   * rend donc un groupe VIDE, sans membres ni historique. Le dire est obligatoire : une
   * suppression annoncée réversible qui rend une coquille serait un faux succès (§104.16).
   */
  CONVERSATION: {
    label: "conversation de groupe",
    module: "Messagerie",
    redirect: "/admin/messagerie",
    model: "conversation",
    reserve: "Les membres et l'historique des messages partent en CASCADE et ne sont pas instantanés : une restauration depuis la corbeille rendrait un groupe VIDE. Les fichiers partagés restent dans le Drive de leur auteur.",
    // Pas d'`entityType` : `EntityType` n'a aucune valeur pour une conversation, donc aucun
    // Document ni Commentaire polymorphe n'y est rattaché — rien à instantaner de ce côté.
    searchFields: ["title"],
    async describe(id) {
      const c = await prisma.conversation.findUnique({
        where: { id },
        select: { title: true, type: true, _count: { select: { members: true, messages: true } } },
      });
      if (!c) return null;
      const quoi = c.type === "CHANNEL" ? "Canal" : c.type === "GROUP" ? "Groupe" : "Conversation directe";
      const nom = c.title?.trim() || "sans titre";
      return `${quoi} « ${nom} » — ${c._count.members} membre(s), ${c._count.messages} message(s)`;
    },
    async refuse(id) {
      const c = await prisma.conversation.findUnique({ where: { id }, select: { type: true } });
      if (!c) return null; // l'inexistence se dit « introuvable », pas « refusé ».
      // Un tête-à-tête est l'échange PRIVÉ de deux personnes : le supprimer effacerait leur
      // correspondance pour les deux, sans qu'aucune l'ait demandé. Seuls les groupes et les
      // canaux — des espaces d'équipe — se suppriment ici.
      if (c.type === "DIRECT") {
        return "Une conversation directe (tête-à-tête) ne se supprime pas : c'est l'échange privé de deux personnes. Seuls les groupes et les canaux peuvent être supprimés ; un message précis se retire depuis la conversation.";
      }
      return null;
    },
    async remove(id) {
      // Membres et messages suivent en CASCADE (schéma) ; les pièces jointes du Drive, elles,
      // sont en `SetNull` — un fichier partagé dans le groupe reste dans le Drive de son auteur.
      await prisma.conversation.delete({ where: { id } });
    },
  },

  /**
   * UNE NOTIFICATION REÇUE par une personne — elle cesse de la voir.
   *
   * Rien ne permettait de retirer une notification : on ne savait que la marquer LUE, ce qui la
   * laisse dans la liste. Une notification mal rédigée, envoyée à la mauvaise personne ou dont
   * l'objet a disparu restait donc chez elle pour toujours.
   *
   * La suppression reste réversible : la ligne est petite, autonome (destinataire, type, titre,
   * corps, lien, lu, pop-up, date) et n'a aucun enfant — la corbeille la recrée à l'identique.
   */
  NOTIFICATION: {
    label: "notification",
    module: "Administration",
    redirect: "/admin/messagerie",
    model: "notification",
    searchFields: ["title"],
    async describe(id) {
      const n = await prisma.notification.findUnique({
        where: { id },
        select: { title: true, isRead: true, createdAt: true, user: { select: { name: true } } },
      });
      if (!n) return null;
      return `« ${n.title} » — reçue par ${n.user.name} le ${n.createdAt.toLocaleDateString("fr-FR")} (${n.isRead ? "lue" : "non lue"})`;
    },
    async remove(id) {
      await prisma.notification.delete({ where: { id } });
    },
  },

  /**
   * UN ÉLÉMENT DU DRIVE « SUPPRIMÉ DÉFINITIVEMENT » DEPUIS LA CORBEILLE DU DRIVE (Direction, 10/2026 : « quand je
   * supprime, il doit toujours être récupérable — dans la corbeille du Drive, et, une fois supprimé de celle-ci,
   * par la corbeille du Super Admin »).
   *
   * Un LOT : le fichier (ou le dossier et tout son contenu) part avec ses versions, ses partages, ses commentaires,
   * son index de recherche — et revient avec eux. Les OCTETS ne sont jamais libérés ici : les versions de la ligne
   * de corbeille les tiennent (le ramasse-miettes lit les `blobId` des lignes de corbeille), et seule la
   * destruction réelle (`destroyDeletedRecord`) rend les références. Réservé au Super Admin pour la restauration
   * (aucun module délégué : `MODULE_DU_TYPE` ne le nomme pas).
   */
  DRIVE_NODE: {
    label: "élément du Drive",
    module: "Drive",
    redirect: "/drive",
    model: "driveNode",
    entityType: "DRIVE_NODE",
    searchFields: ["name"],
    lot: true,
    async describe(id) {
      const n = await prisma.driveNode.findUnique({ where: { id }, select: { name: true, type: true } });
      return n ? (n.type === "FOLDER" ? `Dossier « ${n.name} »` : n.name) : null;
    },
    async remove(id) {
      await prisma.driveNode.delete({ where: { id } });
    },
    // RESTAURER, C'EST RETROUVER LE FICHIER DANS LE DRIVE — pas dans la corbeille du Drive où il était au moment
    // de la suppression : le Super Admin le rend à son propriétaire. Même règle que « Restaurer » du Drive : dans
    // son dossier s'il est encore là et hors corbeille, sinon à la racine.
    async restored(id) {
      const ids: string[] = [];
      let frontiere = [id];
      while (frontiere.length) {
        ids.push(...frontiere);
        frontiere = (await prisma.driveNode.findMany({ where: { parentId: { in: frontiere } }, select: { id: true } })).map((c) => c.id);
      }
      await prisma.driveNode.updateMany({ where: { id: { in: ids } }, data: { isTrashed: false } });
      const node = await prisma.driveNode.findUnique({ where: { id }, select: { parentId: true } });
      if (node?.parentId) {
        const parent = await prisma.driveNode.findUnique({ where: { id: node.parentId }, select: { isTrashed: true } });
        if (!parent || parent.isTrashed) await prisma.driveNode.update({ where: { id }, data: { parentId: null } });
      }
    },
  },
};

/** Les kinds dans l'ordre du registre — pour les énumérations (schéma d'outil, messages). */
export const DELETABLE_KINDS = Object.keys(DELETE_REGISTRY) as DeletableKind[];

export function isDeletableKind(v: string): v is DeletableKind {
  return Object.prototype.hasOwnProperty.call(DELETE_REGISTRY, v);
}

/** Délégué Prisma générique (snapshot / restauration / recherche) pour un kind du registre. */
export function deleteDelegateOf(spec: KindSpec) {
  return (prisma as unknown as Record<string, {
    findUnique: (a: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    findMany: (a: { where: Record<string, unknown>; select: { id: true }; take: number }) => Promise<{ id: string }[]>;
    create: (a: { data: Record<string, unknown> }) => Promise<unknown>;
  }>)[spec.model];
}

/** Le nom du MODÈLE Prisma d'une entrée du registre — son délégué, première lettre capitale. */
export function modeleDuRegistre(spec: KindSpec): string {
  return spec.model.charAt(0).toUpperCase() + spec.model.slice(1);
}

/**
 * LE REFUS D'UN LOT — ce qui a quitté l'ERP, nommé. Pas de faux remède : quand un règlement est
 * parti ou qu'une pièce est signée, la demande EST la justification de ce fait, elle reste.
 */
export function refusDuLot(bloquants: readonly string[]): string {
  return `Suppression refusée : ${bloquants.join(" ; ")}. Cet élément justifie ces faits — le supprimer les laisserait sans cause, il reste donc au registre. (Un courrier inscrit se retire d'abord depuis le registre des courriers, si c'est bien voulu.)`;
}

/** Ce qu'une suppression emportera, et ce qui l'interdit — lu AVANT de confirmer (§118.53). */
export interface ApercuSuppression {
  nom: string | null;
  /** « 2 postes », « 1 déclaration d'information médicale »… Vide : l'élément part seul. */
  emporte: string[];
  /**
   * CE QUI RESTE mais PERD SON LIEN avec lui — « 3 dossiers réglementaires » perdent leur projet.
   * Ces lignes ne partent pas : leur lien est vidé, noté, et rétabli à la restauration. Le taire
   * laisserait croire qu'un projet supprimé ne touche à rien, alors que trois dossiers perdent leur
   * classement au même clic (§118.53, §118.163).
   */
  detache: string[];
  refus: string | null;
  /** Vrai : ce qui part avec l'élément REVIENT avec lui à la restauration. */
  lot: boolean;
}

/**
 * L'APERÇU — le MÊME inventaire que la suppression, lu sans rien écrire. L'écran (bouton rouge)
 * et Adam (carte de confirmation) le lisent tous deux : deux rédactions de « ce qui part avec »
 * finiraient par dire deux choses différentes (§118.5).
 */
export async function apercuSuppression(kind: DeletableKind, id: string): Promise<ApercuSuppression> {
  const spec = DELETE_REGISTRY[kind];
  const refusPropre = spec.refuse ? await spec.refuse(id) : null;
  const nom = await spec.describe(id);
  if (!spec.lot || nom === null) return { nom, emporte: [], detache: [], refus: refusPropre, lot: Boolean(spec.lot) };
  const inv = await inventorier(modeleDuRegistre(spec), id);
  if (!inv) return { nom: null, emporte: [], detache: [], refus: refusPropre, lot: true };
  return {
    nom,
    emporte: inv.resume,
    detache: resumeDesLiens(inv.liensExternes),
    refus: refusPropre ?? (inv.bloquants.length ? refusDuLot(inv.bloquants) : null),
    lot: true,
  };
}
