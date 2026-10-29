import { classify } from "./classement";

/**
 * NATIVE et COVERED — les actions serveur que le Chief exécute lui-même, ou dont il rend le même
 * service par un outil équivalent. Premier bloc appelé par le registre.
 */
export function classerNatifsEtCouverts(): void {
  // ── NATIVE : le Chief exécute CETTE action serveur (via l'outil indiqué). ──
  classify("NATIVE", "request_treasury_update", ["finance-actions:requestTreasuryUpdate"]);
  classify("NATIVE", "assign_regulatory_responsible", ["regulatory-actions:setRegulatoryResponsible"]);
  classify("NATIVE", "set_regulatory_step", ["regulatory-actions:setRegulatoryStepState", "regulatory-actions:setRegulatoryPresubOutcome"]);
  classify("NATIVE", "request_regulatory_status_update", ["regulatory-actions:requestRegulatoryStatusUpdate"]);
  classify("NATIVE", "delete_record", ["admin-delete-actions:superAdminDelete"]);
  classify("NATIVE", "restore_record", ["admin-delete-actions:restoreDeletedRecord"]);
  classify("NATIVE", "purge_record", ["admin-delete-actions:destroyDeletedRecord"]);
  classify("NATIVE", "set_account_active", ["admin-actions:toggleUserActive"]);
  classify("NATIVE", "set_account_role", ["admin-actions:updateUserRole", "admin-actions:setSecondaryRole"]);
  classify("NATIVE", "create_task", ["task-actions:createTask"]);
  classify("NATIVE", "update_request", ["admin-request-actions:updateRequestStatus", "admin-request-actions:assignRequest", "admin-request-actions:addRequestComment"]);
  classify("NATIVE", "create_sponsoring_request", ["sponsoring-actions:createSponsoring"]);
  classify("NATIVE", "create_event_request", ["event-actions:createEvent"]);
  classify("NATIVE", "create_legal_document", ["legal-actions:createLegalDocument"]);
  classify("NATIVE", "update_legal_document", ["legal-actions:updateLegalDocument"]);
  classify("NATIVE", "update_calendar_event", ["calendar-actions:updateCalendarEvent", "calendar-actions:deleteCalendarEvent"]);
  classify("NATIVE", "create_hospital", ["medical-actions:createInstitution"]);
  classify("NATIVE", "update_hospital", ["medical-actions:updateInstitution"]);
  classify("NATIVE", "decide_payment", ["payment-centre-actions:decidePayment"]);
  // « Adam, remets l'approbation obligatoire pour les mails. » — le Chief écrit la MÊME politique
  // que l'écran de réglages, derrière la même ressaisie pour armer l'envoi autonome.
  classify("NATIVE", "set_mail_policy", ["adam-settings-actions:setAdamMailPolicy"]);

  // ── COVERED : le même résultat métier, par un outil équivalent du Chief. ──
  classify("COVERED", "update_regulatory_product", [
    "regulatory-actions:updateRegulatoryProduct", "regulatory-actions:updateRegulatoryStatus",
    "regulatory-actions:setRegulatoryPriority", "regulatory-actions:setRegulatoryTargetDates",
    "regulatory-actions:setRegulatoryLock",
  ]);
  classify("COVERED", "create_admin_request", ["admin-request-actions:createRequest"]);
  // LE REGISTRE DE MARQUE (§26) : la charte (couleurs, polices, coordonnées, mentions, signataires) se règle en
  // parlant — `document_profile` (geste definir, champ `marque`), même validation, même audit que l'écran.
  classify("COVERED", "document_profile (geste definir, champ marque)", ["brand-actions:enregistrerMarque"]);
  // LE BOUTON DES FINANCES (§118.135) : composer une facture ou un bon de commande au format de la
  // société, sur son papier en-tête — c'est EXACTEMENT ce que `document_build` fait en conversation
  // (« fais-moi une facture Pharmagène pour Biogalenic… »), par la MÊME fabrique et le même registre ;
  // l'aperçu est la lecture à blanc de la même composition, et le motif de numérotation se règle par
  // `document_profile` (champ `numerotation`).
  classify("COVERED", "document_build", ["fabrique-actions:emettrePieceCommerciale", "fabrique-actions:previsualiserPieceCommerciale"]);
  classify("COVERED", "document_profile (geste definir, champ numerotation)", ["fabrique-actions:reglerNumerotationPieces"]);
  // L'APERÇU D'UNE SUPPRESSION (§118.162) — la fenêtre de l'écran le lit avant le clic ; en
  // conversation, c'est la carte de `delete_record` qui le montre (« Part aussi »), par la même
  // fonction du registre : une seule lecture de « ce qui part avec » pour les deux portes.
  classify("COVERED", "delete_record (carte : « Part aussi »)", ["admin-delete-actions:apercuDeSuppression"]);
  classify("COVERED", "create_task (planifiée, circuit demande)", ["task-actions:requestTask"]);
  classify("COVERED", "update_task", ["task-actions:updateTaskStatus", "task-actions:startTask"]);
  classify("COVERED", "create_dossier", ["dossier-actions:createDossier"]);
  classify("COVERED", "create_calendar_event", ["calendar-actions:createCalendarEvent"]);
  classify("COVERED", "create_hr_request", ["hr-document-actions:requestHrDocument"]);
  classify("COVERED", "create_congress_request", ["congress-request-actions:createCongressRequest"]);
  classify("COVERED", "send_message", ["messaging-actions:sendMessage", "messaging-actions:createDirect"]);
  // PARTAGER UN ÉLÉMENT PAR LA MESSAGERIE : l'action prépare la conversation puis appelle
  // `sendMessage`, l'écrivain unique. Ce qu'elle produit — un message portant une référence et,
  // le cas échéant, des pièces du Drive — `send_message` le produit déjà en conversation, où l'on
  // dit simplement « envoie le dossier REG-2026-041 à Amel ». Le geste d'écran ajoute le
  // confort du bouton, pas une capacité de plus.
  classify("COVERED", "send_message", ["partage-actions:partagerParMessagerie"]);
  classify("COVERED", "send_email", ["mail-actions:sendMailAction", "microsoft-mail-actions:sendMessage", "smart-mail-actions:sendMail"]);
  classify("COVERED", "create_notification", ["notification-actions:sendBroadcast"]);
  classify("COVERED", "update_platform_setting", [
    "settings-actions:saveAppSettings", "settings-actions:setRegEnrollmentEnabled",
    "settings-actions:setRegulatorySupervisorRoles", "settings-actions:setRegulatoryTherapeuticSegments",
    "settings-actions:setDriveSpaceCreatorRoles", "settings-actions:setFieldReportsOverviewRoles",
    "settings-actions:setDirectiveAccess", "settings-actions:setOrgChartViewers", "settings-actions:saveDriveStorageSettings",
    "settings-actions:setHiddenModules",
    // « Dans Regulatory, supprime la colonne classe thérapeutique » : MÊME réglage et MÊME
    // catalogue (`vues/colonnes-regulatory`) que la console d'administration — un autre chemin
    // vers le même levier, jamais un levier caché.
    "settings-actions:setRegulatoryHiddenColumns",
    // QUI ÉCRIT LES MESSAGES PRÉ-DÉFINIS de la promotion médicale — une LISTE DE RÔLES sur
    // `AppSetting`, exactement la forme de `setRegulatorySupervisorRoles` et de
    // `setFieldReportsOverviewRoles` juste au-dessus. La décision de permission reste au Super
    // Admin (§118.108) ; l'outil de réglage de plateforme est le chemin, pas un levier de plus.
    "settings-actions:setPromoMessageAuthorRoles",
    // LE SEUIL Ad & Pro DU DIRECTEUR GÉNÉRAL n'est PLUS ici (§118.149). Il y était déclaré couvert
    // alors que `update_platform_setting` ne le connaissait pas (absent de ses réglages
    // modifiables : la carte aurait répondu « réglage inconnu »). Il a désormais son op —
    // `adpro_operation:set_request_threshold`, comme le seuil des bons de commande — qui appelle
    // l'action de l'écran, avec son siège (Direction Générale ET Super Admin).
  ]);
  classify("COVERED", "find_documents / inspect_drive_folder (lecture)", ["drive-browse-actions:browseDrive"]);
  classify("COVERED", "update_salary", ["payroll-hr-actions:updatePayrollEntry"]);
  // La double implémentation d'écran (admin/users) du MÊME geste métier : l'outil de compte
  // existant produit l'effet identique (activation + sessions révoquées à la désactivation).
  classify("COVERED", "set_account_active", ["access-actions:setUserActive"]);
  // Révoquer UNE session précise exige la liste d'écran (empreinte appareil/date) ; le geste de
  // sécurité demandé en conversation — « déconnecte X de partout » — est couvert intégralement.
  classify("COVERED", "org_operation:revoke_sessions", ["access-actions:revokeSession"]);
  // Wrapper d'écran du MÊME geste : editLegalDocument rejoue updateLegalDocument (couvert).
  classify("COVERED", "update_legal_document", ["legal-actions:editLegalDocument"]);
  // « Adam, suspends les envois » : la politique « brouillons seulement » produit EXACTEMENT le
  // même résultat métier que le coupe-circuit sortant — plus rien ne quitte l'entreprise, même
  // approuvé. Le Chief atteint donc le service par un autre chemin, déjà confirmé et audité.
  classify("COVERED", "set_mail_policy", ["adam-settings-actions:setAdamOutboundPaused"]);
}
