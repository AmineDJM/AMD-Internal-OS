import { cache } from "react";
import { prisma } from "./prisma";

/**
 * SEUIL Ad & Pro PAR DÉFAUT au-delà duquel le Directeur Général valide en plus (§118.138).
 *
 * Il reflète le `@default(1000000)` de la colonne `AppSetting.adProDgThreshold` : c'est le repli
 * du LECTEUR quand la ligne n'existe pas encore. Les deux doivent dire la même chose, et le banc
 * des réglages le vérifie — une valeur par défaut que la base et le code écrivent différemment
 * fait dépendre le circuit de l'existence d'une ligne.
 */
export const SEUIL_DG_DEFAUT = 1_000_000;

/**
 * Réglages d'instance modifiables par le Super Admin (limites de taille d'upload…).
 * Lecture côté serveur ; valeurs par défaut si la ligne n'existe pas (ou souci BDD).
 * Mise en cache par requête.
 */
const perRequest: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

export type BudgetTotalMode = "FIXED" | "FLEXIBLE";

export interface AppSettings {
  /** ARRÊT D'URGENCE : vrai = plus aucune action EXTERNE de l'assistant (lectures inchangées). */
  aiExternalActionsDisabled: boolean;
  maxUploadMb: number;
  maxDriveUploadMb: number;
  /** Budget total : FIXED (montant figé) ou FLEXIBLE (= somme des enveloppes). */
  budgetTotalMode: BudgetTotalMode;
  budgetFixedTotal: number;
  /**
   * SEUIL Ad & Pro au-delà duquel le DIRECTEUR GÉNÉRAL valide en plus (DZD) — §118.138.
   *
   * UN seul chiffre pour les quatre circuits configurables ET pour le matériel promotionnel, qui
   * n'a pas d'étapes en base. Cinq copies auraient divergé au premier ajustement (§118.5), et le
   * symptôme aurait été une demande d'1,2 M arrêtée à l'un des cinq guichets et pas aux autres.
   * `0` = aucune porte du DG.
   */
  adProDgThreshold: number;
  /**
   * SEUIL DES BONS DE COMMANDE (DZD) — §118.149. Un BC STRICTEMENT au-dessus passe par un centre
   * de validation (Ad & Pro ou normal, selon son origine) ; en dessous, il va directement à la
   * signature des Finances. Réglé depuis le centre de validation Ad & Pro. `0` = tout BC passe
   * par un centre (le comportement d'avant la règle, et le plus sûr tant que rien n'est fixé).
   */
  bcValidationThreshold: number;
  /**
   * SEUIL DES BONS DE COMMANDE HORS AD & PRO (DZD) — ceux que valide le CENTRE DE VALIDATIONS, réglé depuis ce centre
   * (Direction, 10/2026). `bcValidationThreshold` ne vaut plus que pour les BC du centre Ad & Pro. `0` = tout BC y passe.
   */
  bcValidationThresholdCentre: number;
  /** Capacité globale du Drive (Go) — modifiable par le Super Admin. */
  driveCapacityGb: number;
  /** Quota Drive par utilisateur (Go) — modifiable par le Super Admin. */
  driveUserQuotaGb: number;
  /** Onglet Regulatory « Enregistrement » (analyseur CTD) — débloqué par le Super Admin. */
  regEnrollmentEnabled: boolean;
  /** Rôles superviseurs Regulatory (en plus du Super Admin) : priorité/dates, notifs, MàJ statut. */
  regulatorySupervisorRoles: string[];
  /** Segments thérapeutiques proposés par le tableau Regulatory. VIDE = la liste par défaut. */
  regulatoryTherapeuticSegments: string[];
  /**
   * COLONNES RETIRÉES du tableau Regulatory — Suivi de dossiers ET Pipeline, pour tout le monde.
   * Ce n'est pas la préférence d'affichage locale au navigateur : voir `regulatory/colonnes.ts`.
   */
  regulatoryHiddenColumns: string[];
  /** Rôles autorisés à CRÉER des « Demandes à Regulatory » (en plus du PRIM). Regulatory RÉPOND mais ne crée pas. */
  /** Rôles autorisés à CRÉER des catégories de Drive (espaces partagés en onglets). En plus du Super Admin. */
  driveSpaceCreatorRoles: string[];
  /** Rôles autorisés à voir l'onglet « Overview » des Rapports terrain (graphes d'analyse). En plus du Super Admin. */
  fieldReportsOverviewRoles: string[];
  /** Rôles autorisés à ÉCRIRE les messages pré-définis de la Direction Marketing. En plus du Super Admin. */
  promoMessageAuthorRoles: string[];
  /** Rôles autorisés à CONSULTER l'organigramme (toutes entités ou la sienne). En plus du Super Admin. */
  orgChartViewerRoles: string[];
  /** Rôles autorisés à voir l'onglet « Enregistrement (CTD) ». VIDE = administrateur seul. */
  regEnrollmentRoles: string[];
  /** Personnes nommément autorisées à consulter l'organigramme (en plus des rôles ci-dessus). */
  orgChartViewerUserIds: string[];
  /** PIPELINE — qui CONSULTE les dossiers verrouillés (rôles / personnes). Voir `lib/regulatory/pipeline-access.ts`. */
  pipelineViewerRoles: string[];
  pipelineViewerUserIds: string[];
  /** PIPELINE — qui tient le CADENAS (ouvrir un dossier = le publier à toute l'entreprise). */
  pipelineManagerRoles: string[];
  pipelineManagerUserIds: string[];
  /** DIRECTIVES — qui LIT les notes de service, et qui en RÉDIGE. Voir `lib/directives/access.ts`.
   *  La PUBLICATION, elle, ne se règle pas : elle appartient à la direction générale. */
  directiveReaderRoles: string[];
  directiveReaderUserIds: string[];
  directiveIssuerRoles: string[];
  directiveIssuerUserIds: string[];
  /** Modules RETIRÉS de la plateforme (menu ET adresse). Voir `lib/modules-visibility.ts`. */
  hiddenModules: string[];
  /**
   * LE SERVICE DES MOYENS GÉNÉRAUX — un seul, pour toute la société.
   *
   * Les moyens généraux ne sont pas « ceux de mon département » : c'est un service qui achète et
   * décaisse pour tout le monde. Chacun arrive donc sur la MÊME caisse. Le découpage par
   * département reste la façon dont l'argent est IMPUTÉ, mais il ne se pilote plus que depuis le
   * compte Super Admin. Nul = aucun service désigné, on retombe sur le rattachement.
   */
  generalMeansDepartmentId: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  aiExternalActionsDisabled: false,
  // Limites généreuses : un ZIP de dossier entier (Documents/Regulatory/messagerie) dépasse
  // facilement les anciennes 25 Mo → l'envoi montait à 100 % puis « échec ». putBlob stocke en
  // tranches (~1 Go) donc le stockage suit. Réglable en Administration.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? "200"),
  maxDriveUploadMb: Number(process.env.MAX_DRIVE_UPLOAD_MB ?? process.env.MAX_UPLOAD_MB ?? "10240"),
  budgetTotalMode: "FLEXIBLE",
  budgetFixedTotal: 0,
  adProDgThreshold: SEUIL_DG_DEFAUT,
  bcValidationThreshold: 0,
  bcValidationThresholdCentre: 0,
  driveCapacityGb: 100,
  driveUserQuotaGb: 10,
  regEnrollmentEnabled: false,
  regulatorySupervisorRoles: [],
  regulatoryTherapeuticSegments: [],
  regulatoryHiddenColumns: [],
  driveSpaceCreatorRoles: [],
  fieldReportsOverviewRoles: [],
  // LA DIRECTION MARKETING ÉCRIT SES MESSAGES PAR DÉFAUT (Direction, 07/10) — le Super Admin peut toujours
  // retirer ou ajouter des rôles ; la migration `20270115140000_cockpit_marketing_auteurs` a posé le même défaut en base.
  promoMessageAuthorRoles: ["PRODUCT_MANAGER"],
  orgChartViewerRoles: [],
  orgChartViewerUserIds: [],
  // Listes VIDES : par défaut, le pipeline reste ce qu'il était — le Super Admin, et lui seul.
  pipelineViewerRoles: [],
  pipelineViewerUserIds: [],
  pipelineManagerRoles: [],
  pipelineManagerUserIds: [],
  // Listes VIDES : par défaut, les directives restent distribuées par la seule matrice de rôles.
  directiveReaderRoles: [],
  directiveReaderUserIds: [],
  directiveIssuerRoles: [],
  directiveIssuerUserIds: [],
  regEnrollmentRoles: [],
  hiddenModules: [],
  generalMeansDepartmentId: null,
};

export const getAppSettings = perRequest(async (): Promise<AppSettings> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_APP_SETTINGS;
    return {
      aiExternalActionsDisabled: row.aiExternalActionsDisabled === true,
      maxUploadMb: row.maxUploadMb,
      maxDriveUploadMb: row.maxDriveUploadMb,
      budgetTotalMode: row.budgetTotalMode === "FIXED" ? "FIXED" : "FLEXIBLE",
      budgetFixedTotal: Number(row.budgetFixedTotal),
      adProDgThreshold: Number(row.adProDgThreshold),
      bcValidationThreshold: Number(row.bcValidationThreshold),
      bcValidationThresholdCentre: Number(row.bcValidationThresholdCentre),
      driveCapacityGb: row.driveCapacityGb,
      driveUserQuotaGb: row.driveUserQuotaGb,
      regEnrollmentEnabled: row.regEnrollmentEnabled,
      regulatorySupervisorRoles: row.regulatorySupervisorRoles ?? [],
      regulatoryTherapeuticSegments: row.regulatoryTherapeuticSegments ?? [],
      regulatoryHiddenColumns: row.regulatoryHiddenColumns ?? [],
      driveSpaceCreatorRoles: row.driveSpaceCreatorRoles ?? [],
      fieldReportsOverviewRoles: row.fieldReportsOverviewRoles ?? [],
      promoMessageAuthorRoles: row.promoMessageAuthorRoles ?? [],
      orgChartViewerRoles: row.orgChartViewerRoles ?? [],
      orgChartViewerUserIds: row.orgChartViewerUserIds ?? [],
      pipelineViewerRoles: row.pipelineViewerRoles ?? [],
      pipelineViewerUserIds: row.pipelineViewerUserIds ?? [],
      pipelineManagerRoles: row.pipelineManagerRoles ?? [],
      pipelineManagerUserIds: row.pipelineManagerUserIds ?? [],
      directiveReaderRoles: row.directiveReaderRoles ?? [],
      directiveReaderUserIds: row.directiveReaderUserIds ?? [],
      directiveIssuerRoles: row.directiveIssuerRoles ?? [],
      directiveIssuerUserIds: row.directiveIssuerUserIds ?? [],
      regEnrollmentRoles: row.regEnrollmentRoles ?? [],
      hiddenModules: row.hiddenModules ?? [],
      generalMeansDepartmentId: row.generalMeansDepartmentId ?? null,
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
});
