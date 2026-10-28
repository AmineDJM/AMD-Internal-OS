/**
 * Registre des suppressions — les TYPES : la liste des genres supprimables (`DeletableKind`) et la
 * fiche d'un genre (`KindSpec`). Réexportés par la porte `lib/admin-delete-registry`.
 */

import type { EntityType } from "@prisma/client";

/** Types d'enregistrements que le Super Admin peut supprimer définitivement. */
export type DeletableKind =
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
