import type { Ecart, Exception, Regle } from "./analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉCARTS SCHÉMA ↔ BASE CONNUS — mesurés le 2026-10-27 sur une base vide migrée par
 * `prisma migrate deploy` (465 migrations), classés dans docs/architecture/refonte-p0-outillage.md.
 *
 * Deux natures, à ne pas confondre :
 *   - VOULU : la base porte ce que Prisma ne sait pas modéliser (index trigramme / plein texte,
 *     colonnes `tsvector`, unicités partielles) ou ce qu'on garde par prudence (tables
 *     historiques jamais supprimées). Ces lignes ne disparaîtront pas.
 *   - DETTE : le schéma et le SQL disent la même chose différemment (index non déclaré, clé
 *     étrangère sans `ON UPDATE CASCADE`, nom d'index court). Sans risque aujourd'hui, à solder
 *     au fil de la refonte — et le test exige alors de RETIRER la ligne (exception périmée).
 *
 * Ajouter une ligne ici, c'est accepter une dérive : la raison est obligatoire et doit dire
 * pourquoi la base et le schéma ont le droit de diverger. « Le test était rouge » n'en est pas une.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function groupe(raison: string, cles: string[]): Exception[] {
  return cles.map((cle) => ({ cle, raison }));
}

/**
 * RÈGLE — `updatedAt` : les migrations SQL écrivent `"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT
 * CURRENT_TIMESTAMP` (convention maison, KB 03 §4), Prisma modélise `@updatedAt` sans défaut en
 * base (le client pose la valeur à chaque écriture). Le défaut SQL ne sert qu'aux insertions en
 * SQL brut, et c'est voulu. 120 colonnes au 2026-10-27 ; toute nouvelle table suit la même
 * convention, d'où une règle et non une liste.
 */
export const REGLES: Regle[] = [
  {
    nom: "updatedAt-defaut-sql",
    accepte: (e: Ecart) => /^defaut:[^.]+\.updatedAt:DROP$/.test(e.cle),
    raison:
      "Le SQL pose DEFAULT CURRENT_TIMESTAMP sur updatedAt, Prisma le gère côté client (@updatedAt) : défaut utile aux seules insertions SQL brutes.",
  },
  /**
   * TRANSITOIRE — `legal/facture-reprise.test.ts` remonte dans `public`, le temps de son
   * `beforeAll`, l'ancienne table `Invoice` (et son enum) pour rejouer la migration qui la
   * supprime. Sous `npm test` les fichiers tournent en parallèle : si le diff tombe dans cette
   * fenêtre, il voit ces objets. Une règle et non une exception, car ils sont ABSENTS hors de
   * cette fenêtre (une exception serait déclarée périmée à chaque passage normal).
   */
  /**
   * VOULU — l'unicité PARTIELLE des ordres vivants par source (DONNEES-10, migration 20270205120000) : Prisma 5 ne sait
   * pas écrire `WHERE status <> 'CANCELLED' AND "sourceType" IN (…)`. Une règle et non une exception : la migration
   * ne pose pas l'index sur une base qui porte déjà des doublons vivants (elle le dit), si bien qu'il peut manquer.
   */
  {
    nom: "ordre-source-unique-vivant",
    accepte: (e: Ecart) => e.cle === "index:ExpenseOrder_source_unique_vivant:DROP",
    raison: "Unicité partielle des ordres vivants d'une demande de paiement / d'une avance (DONNEES-10) : inexprimable en Prisma 5.",
  },
  {
    nom: "banc-facture-reprise",
    accepte: (e: Ecart) => /^(table:Invoice:|type:InvoiceStatus:|fk:Invoice_|index:Invoice_)/.test(e.cle),
    raison: "Objets remontés temporairement par legal/facture-reprise.test.ts, supprimés par son afterAll.",
  },
];

export const EXCEPTIONS: Exception[] = [
  // ── VOULU : recherche plein texte / trigramme, inexprimable en Prisma 5 ─────────────────
  ...groupe(
    "Index GIN trigramme (pg_trgm) ou plein texte (tsvector) : Prisma 5 ne les modélise pas ; ils servent la recherche floue et ne vivent qu'en SQL.",
    [
      "index:AnppReserve_verbatim_trgm_idx:DROP",
      "index:DriveTextIndex_textFold_trgm:DROP",
      "index:KnowledgeAlias_aliasFold_trgm:DROP",
      "index:KnowledgeChunk_textFold_trgm:DROP",
      "index:KnowledgeItem_textFold_trgm:DROP",
      "index:RegulatoryExtraction_tsv_idx:DROP",
      "index:RegulatorySourceSection_search_idx:DROP",
      "index:RegulatorySourceSection_trgm_idx:DROP",
    ],
  ),
  ...groupe(
    "Colonne tsvector générée par le SQL pour la recherche plein texte ; volontairement absente du schéma (type non supporté par Prisma 5).",
    ["colonne:RegulatoryExtraction.tsv:DROP", "colonne:RegulatorySourceSection.search_vector:DROP"],
  ),

  // ── VOULU : unicités PARTIELLES (invariants métier), que Prisma 5 ne sait pas écrire ────
  ...groupe(
    "Le schéma déclare une unicité totale ; la base porte la même unicité restreinte aux lignes non nulles (index partiel WHERE … IS NOT NULL). Sémantiquement présente, Prisma ne voit pas la clause WHERE.",
    [
      "index:MissionStep_idempotencyKey_key:CREATE UNIQUE",
      "index:AssistantEpisode_userId_fromMessageId_toMessageId_key:CREATE UNIQUE",
    ],
  ),
  ...groupe(
    "Index SQL en tri DESC sur endedAt (lecture « les plus récents d'abord ») ; le schéma déclare le même couple sans le sens du tri et sous un autre nom.",
    [
      "index:AssistantEpisode_thread_idx:DROP",
      "index:AssistantEpisode_user_ended_idx:DROP",
      "index:AssistantEpisode_threadId_endedAt_idx:CREATE",
      "index:AssistantEpisode_userId_endedAt_idx:CREATE",
    ],
  ),

  // ── VOULU : tables et colonne historiques, jamais supprimées (aucun DROP en migration) ──
  ...groupe(
    "Table historique conservée en base (KB 03 §6 : aucune suppression destructive). Remplacée par BusinessUnit (20261002090000_bu_colonne_vertebrale) ; retirée du schéma seulement.",
    [
      "table:SalesTeam:DROP",
      "fk:SalesTeam_businessUnitId_fkey:DROP",
      "colonne:SalesRepProfile.teamId:DROP",
      "fk:SalesRepProfile_teamId_fkey:DROP",
      "index:SalesRepProfile_teamId_idx:DROP",
    ],
  ),
  ...groupe(
    "Table historique conservée en base : liens courrier ↔ entité, remplacés par le registre unique EntityLink (20261001160000_entity_link_registry, qui y a recopié les lignes) ; retirée du schéma seulement, aucune suppression destructive.",
    ["table:MailEntryLink:DROP", "fk:MailEntryLink_entryId_fkey:DROP"],
  ),

  // ── DETTE : défauts SQL de tableaux / textes que le schéma ne déclare pas ───────────────
  ...groupe(
    "Le SQL pose DEFAULT '{}' (ou '') ; le schéma n'a pas de @default. Sans effet : le client Prisma envoie toujours la valeur. À aligner en ajoutant @default([]) au schéma (sans migration).",
    [
      "defaut:ApiClient.scopes:DROP",
      "defaut:AuthorityHolder.roles:DROP",
      "defaut:AuthorityHolder.userIds:DROP",
      "defaut:DriveTextIndex.textFold:DROP",
      "defaut:WebhookEndpoint.events:DROP",
      "defaut:WorkflowInstance.skippedSlugs:DROP",
    ],
  ),
  ...groupe(
    "Le schéma déclare @default(\"global\") sur l'id du singleton, la base ne le porte pas. Sans effet : les deux écritures (sales-planning-actions.ts) font un upsert avec id explicite.",
    ["defaut:SfeSettings.id:SET 'global'"],
  ),

  // ── DETTE : index créés en SQL, jamais déclarés dans le schéma (@@index manquant) ───────
  ...groupe(
    "Index B-tree simple créé par une migration mais absent du schéma (@@index manquant). Utile en lecture ; à déclarer dans le schéma (aucune migration : l'index existe déjà).",
    [
      "index:AdProItem_trainingId_idx:DROP",
      "index:AssistantReminder_targetUserId_idx:DROP",
      "index:BdProduct_regulatoryProductId_idx:DROP",
      "index:BudgetCategoryLine_module_idx:DROP",
      "index:BusinessUnit_departmentId_idx:DROP",
      "index:CompanyContact_sphere_idx:DROP",
      "index:CongressInternational_businessUnitId_idx:DROP",
      "index:CongressNational_businessUnitId_idx:DROP",
      "index:Document_entityType_entityId_stepKey_idx:DROP",
      "index:Employee_companyId_idx:DROP",
      "index:Event_businessUnitId_idx:DROP",
      "index:Event_requestStatus_idx:DROP",
      "index:ExpenseOrder_deferredUntil_idx:DROP",
      "index:FinanceTransaction_companyId_idx:DROP",
      "index:LeaveRequest_stage_idx:DROP",
      "index:LegalDocument_folderId_idx:DROP",
      "index:LogisticsOrder_companyId_idx:DROP",
      "index:MedicalDoctor_companyId_idx:DROP",
      "index:MedicalInfoDeclaration_bvRequestId_idx:DROP",
      "index:MedicalInfoDeclaration_bvValidationId_idx:DROP",
      "index:MedicalInfoDeclaration_companyId_idx:DROP",
      "index:MedicalVisit_tourPlanId_idx:DROP",
      "index:Meeting_reminder_idx:DROP",
      "index:Mission_status_priority_idx:DROP",
      "index:MissionArtifact_missionId_inputsHash_idx:DROP",
      "index:MissionStep_missionId_supersededAt_idx:DROP",
      "index:PchTender_companyId_idx:DROP",
      "index:PromoMaterial_businessUnitId_idx:DROP",
      "index:PromoMaterial_circuitState_idx:DROP",
      "index:PromoMaterial_companyId_idx:DROP",
      "index:PromoMaterial_managerId_idx:DROP",
      "index:PromoProduct_regulatoryProductId_idx:DROP",
      "index:RegulatoryDocument_ctdSection_idx:DROP",
      "index:RegulatoryProduct_companyId_idx:DROP",
      "index:Sale_companyId_idx:DROP",
      "index:SponsoringRequest_businessUnitId_idx:DROP",
      "index:StockSnapshot_companyId_idx:DROP",
      "index:Task_status_evidenceAt_idx:DROP",
      "index:ValidationRequest_documentId_idx:DROP",
    ],
  ),

  // ── DETTE : même index, nom court en SQL, nom Prisma par défaut dans le schéma ──────────
  ...groupe(
    "Même index, mêmes colonnes : la migration l'a nommé court, le schéma attend le nom Prisma par défaut. À aligner par map: \"…\" dans le schéma (sans migration).",
    [
      "index:AssistantEpisode_fidelity_idx->AssistantEpisode_userId_fidelity_idx:RENAME",
      "index:DocumentRequest_entity_idx->DocumentRequest_entityType_entityId_idx:RENAME",
      "index:KnowledgeItem_company_current_idx->KnowledgeItem_companyId_isCurrent_idx:RENAME",
      "index:KnowledgeJob_item_idx->KnowledgeJob_itemId_kind_idx:RENAME",
      "index:KnowledgeJob_pick_idx->KnowledgeJob_status_runAfter_priority_idx:RENAME",
      "index:KnowledgeLink_edge_key->KnowledgeLink_itemId_predicate_toType_toId_key:RENAME",
      "index:KnowledgeLink_target_idx->KnowledgeLink_toType_toId_idx:RENAME",
      "index:MissionStep_mission_workstream_idx->MissionStep_missionId_workstream_idx:RENAME",
    ],
  ),

  // ── DETTE : clés étrangères identiques sauf ON UPDATE (SQL sans ON UPDATE CASCADE) ──────
  ...groupe(
    "Même clé étrangère, même ON DELETE ; le SQL omet ON UPDATE CASCADE (NO ACTION en base). Sans effet : les id (cuid) ne sont jamais modifiés.",
    [
      "fk:ExecutiveCommitment_missionId_fkey:DROP",
      "fk:ExecutiveCommitment_missionId_fkey:ADD",
      "fk:Mission_parentMissionId_fkey:DROP",
      "fk:Mission_parentMissionId_fkey:ADD",
      "fk:MissionApproval_missionId_fkey:DROP",
      "fk:MissionApproval_missionId_fkey:ADD",
      "fk:MissionStep_missionId_fkey:DROP",
      "fk:MissionStep_missionId_fkey:ADD",
      "fk:MissionStepDep_dependsOnId_fkey:DROP",
      "fk:MissionStepDep_dependsOnId_fkey:ADD",
      "fk:MissionStepDep_stepId_fkey:DROP",
      "fk:MissionStepDep_stepId_fkey:ADD",
      "fk:MissionWorkerRun_missionId_fkey:DROP",
      "fk:MissionWorkerRun_missionId_fkey:ADD",
      "fk:MissionWorkerRun_stepId_fkey:DROP",
      "fk:MissionWorkerRun_stepId_fkey:ADD",
      "fk:OperationalTemplate_ownerId_fkey:DROP",
      "fk:OperationalTemplate_ownerId_fkey:ADD",
    ],
  ),

  // ── DETTE : clés étrangères posées en SQL sur des champs que le schéma garde scalaires ──
  ...groupe(
    "Clé étrangère présente en base, champ scalaire sans @relation dans le schéma. L'intégrité est tenue par la base ; le client Prisma n'offre simplement pas la navigation. À déclarer en relation (sans migration).",
    [
      "fk:BesoinAnnuelService_decideurId_fkey:DROP",
      "fk:BesoinAnnuelService_institutionId_fkey:DROP",
      "fk:BesoinAnnuelService_productId_fkey:DROP",
      "fk:BesoinAnnuelService_serviceId_fkey:DROP",
      "fk:InfluenceScore_doctorId_fkey:DROP",
      "fk:PraticienRelation_fromDoctorId_fkey:DROP",
      "fk:PraticienRelation_toDoctorId_fkey:DROP",
    ],
  ),

  // ── DETTE RÉELLE : le schéma promet une contrainte que la base n'a pas ──────────────────
  ...groupe(
    "SEUL ÉCART OÙ LA BASE EST PLUS FAIBLE QUE LE SCHÉMA : MissionInput.milestoneId est déclaré en relation (onDelete: SetNull) mais 20260908130000_missions_long_horizon ne pose pas la clé étrangère. Un jalon supprimé laisse un milestoneId orphelin. À corriger par une migration idempotente (hors lot P0, qui n'en contient aucune).",
    ["fk:MissionInput_milestoneId_fkey:ADD"],
  ),
];
