import { classify, G } from "./classement";

/**
 * GAP — les actions d'écran RECONNUES, pas encore proposables par le Chief (le catalogue d'ops en
 * reclasse ensuite une partie en NATIVE). Contient aussi quelques NATIVE/COVERED posés après.
 */
export function classerTrous(): void {
  // ── GAP : action d'écran RECONNUE, pas encore proposable par le Chief. ──
  G("écritures Drive (créer/renommer/déplacer/partager/corbeille) — prochain lot, mêmes actions canoniques", [
    "drive-actions:createFolder", "drive-actions:ensureDriveFolders", "drive-actions:getDriveNodeShares",
    "drive-actions:renameNode", "drive-actions:moveNode", "drive-actions:trashNode", "drive-actions:restoreNode",
    "drive-actions:deleteNode", "drive-actions:shareNode", "drive-actions:shareNodeWithMany", "drive-actions:unshareNode",
    "drive-actions:createOfficeNode", "drive-actions:convertNodeToPdf", "drive-actions:trashNodes",
    "drive-actions:shareNodesWithMany", "drive-actions:copyNodes", "drive-actions:moveNodes",
    "drive-space-actions:createDriveSpace", "drive-space-actions:updateDriveSpace",
    "drive-space-actions:archiveDriveSpace", "drive-space-actions:deleteDriveSpace",
    "drive-comment-actions:postDriveComment", "drive-comment-actions:deleteDriveComment",
  ]);
  G("création de dossier Regulatory (formulaire riche : référence, DCI, entité, segments…)", ["regulatory-actions:createRegulatoryProduct"]);
  G("participants / accès du dossier Regulatory", ["regulatory-actions:setRegulatoryParticipants"]);
  G("détail d'étape (dates planifiée/réelle, pièces manquantes, note) au-delà du statut", ["regulatory-actions:updateRegulatoryStep", "regulatory-actions:setRegulatoryStepNote"]);
  G("commentaires de dossier Regulatory", ["regulatory-actions:addRegulatoryComment"]);
  G("déverrouillage global, BV, checklist, variations, classification, fournisseur Regulatory", [
    "regulatory-actions:unlockAllRegulatory", "regulatory-actions:requestBV",
    "regulatory-actions:setRegulatoryChecklistItem", "regulatory-actions:createVariation",
    "regulatory-actions:setVariationStatus", "regulatory-actions:deleteVariation",
    "regulatory-actions:setRegulatoryClassification", "regulatory-actions:createRegulatorySupplier",
    "regulatory-reminder-actions:sendRegulatoryUpdateReminder",
  ]);
  G("écritures comptables & trésorerie (créer/modifier/importer/soldes d'ouverture)", [
    "finance-actions:createTransaction", "finance-actions:updateTransactionStatus", "finance-actions:updateTransaction",
    "finance-actions:deleteTransaction", "finance-actions:importTransactions", "finance-actions:setTreasuryOpeningBalance",
    "finance-actions:deleteTreasuryAccount", "finance-actions:createQuickIncome",
    "finance-actions:createEmployee", "finance-actions:createPayroll",
  ]);
  G("factures (créer/payer/supprimer)", ["invoice-actions:createInvoice", "invoice-actions:updateInvoice", "invoice-actions:setInvoicePaid", "invoice-actions:deleteInvoice"]);
  G("budgets & enveloppes (créer/attribuer/dépenser)", [
    "budget-actions:createBudget", "budget-envelope-actions:setBudgetTotal", "budget-envelope-actions:createEnvelope",
    "budget-envelope-actions:updateEnvelope", "budget-envelope-actions:deleteEnvelope",
    "budget-envelope-actions:createBudgetCategory", "budget-envelope-actions:updateBudgetCategory",
    "budget-envelope-actions:deleteBudgetCategory", "budget-envelope-actions:attributeTransaction",
    "budget-envelope-actions:addBudgetExpense", "budget-envelope-actions:updateBudgetExpense",
    "budget-envelope-actions:deleteBudgetExpense",
    "department-budget-actions:setDepartmentBudgetAccess", "department-budget-actions:setDepartmentBudget",
    "department-budget-actions:requestDepartmentBudget", "department-budget-actions:decideDepartmentBudgetRequest",
    "department-budget-actions:addDepartmentExpense", "department-budget-actions:updateDepartmentExpense",
    "department-budget-actions:deleteDepartmentExpense",
  ]);
  G("caisse d'avance (allouer/dépenser/recharger)", [
    "petty-cash-actions:allotPettyCash", "petty-cash-actions:confirmPettyCashReceipt", "petty-cash-actions:closePettyCash",
    "petty-cash-actions:spendFromPettyCash", "petty-cash-actions:requestPettyCashTopUp",
    "petty-cash-actions:decidePettyCashTopUp", "petty-cash-actions:setPettyCashPlan",
  ]);
  G("ordres de dépense (règlement, report de paiement, facture)", [
    "expense-actions:settleExpenseOrder", "expense-actions:requestInvoice",
    "expense-actions:deferExpenseOrder", "expense-actions:resumeExpenseOrder",
  ]);
  G("demandes de paiement (création/pièces/décisions du circuit)", [
    "payment-request-actions:createPaymentRequest", "payment-request-actions:addPaymentPiece",
    "payment-request-actions:commentPaymentPiece", "payment-request-actions:reviewPaymentPiece",
    "payment-request-actions:addPaymentComment", "payment-request-actions:submitPaymentRequest",
    "payment-request-actions:decidePaymentRequest", "payment-request-actions:cancelPaymentRequest",
    "payment-request-actions:updatePaymentRequestDetails",
    "payment-centre-actions:respondToPaymentCentre",
  ]);
  G("paie RH (saisir un salaire, annuler une saisie)", ["payroll-hr-actions:markSalaryPaid", "payroll-hr-actions:unmarkSalaryPaid"]);
  G("RH : fiche employé, congés/avances (décisions), documents employé", [
    "hr-actions:createEmployee", "hr-actions:updateEmployee",
    "hr-actions:setEmployeeActive", "hr-actions:requestLeave", "hr-actions:decideLeave", "hr-actions:cancelLeave",
    "hr-actions:updateLeaveRequest", "hr-actions:requestAdvance", "hr-actions:decideAdvance", "hr-actions:cancelAdvance",
    "hr-document-actions:addHrRequestComment", "hr-document-actions:processHrRequest",
    "hr-document-actions:decideExpenseReport", "hr-document-actions:decideHrLeave",
    "hr-document-actions:ackExpenseOriginals", "hr-document-actions:proposeHrMeeting",
    "hr-document-actions:confirmHrMeeting", "hr-document-actions:deleteHrRequest",
    "hr-document-actions:deleteEmployeeDocument", "hr-document-actions:setEmployeeDocumentVisibility",
  ]);
  G("recrutement (circuit complet)", [
    "recruitment-actions:createRecruitmentRequest", "recruitment-actions:decideRecruitmentStep",
    "recruitment-actions:cancelRecruitmentRequest", "recruitment-actions:askRecruitmentInfo",
    "recruitment-actions:answerRecruitmentInfo", "recruitment-actions:openRecruitmentSourcing",
    "recruitment-actions:closeRecruitmentRequest", "recruitment-actions:addRecruitmentCandidate",
    "recruitment-actions:moveRecruitmentCandidate", "recruitment-actions:onboardRecruitment",
  ]);
  G("formations (demande, décision, invitations)", [
    "training-actions:requestTraining", "training-actions:createHrTraining", "training-actions:decideTraining",
    "training-actions:updateTraining", "training-actions:inviteTrainingParticipants",
    "training-actions:respondToTrainingInvitation",
  ]);
  G("réunions (créer/inviter/répondre/compte rendu)", [
    "meeting-actions:setMeetingLink", "meeting-actions:createMeeting", "meeting-actions:updateMeeting",
    "meeting-actions:respondToMeetingInvite", "meeting-actions:setMeetingLive", "meeting-actions:endMeeting",
    "meeting-actions:startCall", "meeting-actions:addMeetingParticipants", "meeting-actions:removeMeetingParticipant",
    "meeting-actions:saveMeetingTranscript", "meeting-actions:summarizeMeeting", "meeting-actions:acceptMeetingProposal",
    "meeting-actions:dismissMeetingProposal", "meeting-actions:deleteMeeting", "meeting-actions:postMeetingMessage",
    "meeting-actions:deleteMeetingMessage",
  ]);
  G("messagerie avancée (groupes, canaux, épingles, réactions, membres)", [
    "messaging-actions:createGroup", "messaging-actions:createChannel", "messaging-actions:editMessage",
    "messaging-actions:deleteMessage", "messaging-actions:toggleReaction", "messaging-actions:togglePinMessage",
    "messaging-actions:bookmarkMessage", "messaging-actions:togglePinConversation", "messaging-actions:toggleMute",
    "messaging-actions:setNotifyLevel", "messaging-actions:updateConversation", "messaging-actions:addMembers",
    "messaging-actions:removeMember", "messaging-actions:setMemberRole", "messaging-actions:leaveConversation",
    "messaging-actions:archiveConversation", "messaging-actions:joinChannel", "messaging-actions:setMessagingStatus",
  ]);
  G("boîte e-mail avancée (signature — le reste est EXCLU plus bas)", [
    "microsoft-mail-actions:saveMailSignature", "mail-actions:updateMailSignature",
  ]);
  G("registre des courriers (créer/classer/pièces/partenaires)", [
    "mail-register-actions:createMailEntry", "mail-register-actions:editMailEntry", "mail-register-actions:setMailDate",
    "mail-register-actions:deleteMailEntry", "mail-register-actions:attachDriveNodeToMail",
    "mail-folder-actions:createMailFolder", "mail-folder-actions:updateMailFolder", "mail-folder-actions:deleteMailFolder",
    "mail-folder-actions:moveMailEntries", "mail-partner-actions:createMailPartner",
    "mail-partner-actions:updateMailPartner", "mail-partner-actions:deleteMailPartner",
    "mail-piece-actions:addMailPiece", "mail-piece-actions:updateMailPiece", "mail-piece-actions:deleteMailPiece",
  ]);
  // NB : editLegalDocument est classé COVERED plus haut — le mettre ici l'écraserait en GAP
  // (les blocs s'exécutent dans l'ordre du fichier ; seul le override catalogue est final).
  G("Legal avancé (édition, dossiers, rattachements Drive, règlement de facture, lecteurs)", [
    "legal-actions:attachDriveNodeToLegal", "legal-actions:renewLegalDocument",
    "legal-actions:cancelLegalDocument", "legal-actions:deleteLegalDocument", "legal-actions:setLegalReaders",
    "legal-actions:sendLegalInvoiceToSettlement", "legal-folder-actions:createLegalFolder",
    "legal-folder-actions:updateLegalFolder", "legal-folder-actions:deleteLegalFolder",
    "legal-folder-actions:moveLegalDocuments",
  ]);
  // Le rattachement d'une pièce Legal existante (`ad-pro-rattacher-legal`) n'est PAS ici : il est
  // couvert par `legal_operation/link_record` et `unlink_record`, donc reclassé NATIVE par le
  // catalogue. Le mettre dans ce bloc l'écraserait en GAP le temps de la lecture, pour rien.
  G("Ad&Pro (postes, décisions, transferts, consulting)", [
    "ad-pro-edit-actions:updateAdProRequest", "ad-pro-item-actions:addAdProItem", "ad-pro-item-actions:updateAdProItem",
    "ad-pro-item-actions:deleteAdProItem",
    "ad-pro-item-actions:linkPromoMaterial",
    "ad-pro-item-actions:submitAdProItem", "ad-pro-item-actions:decideAdProItem", "ad-pro-item-actions:setAdProItemBudget",
    "ad-pro-item-actions:demanderPieceSecretariat", "ad-pro-item-actions:requestAdProItemOrder",
    "ad-pro-item-actions:approveAdProItemOrder", "ad-pro-other-actions:createAdProOtherRequest",
    "ad-pro-other-actions:decideAdProOtherRequest", "ad-pro-other-actions:closeAdProOtherRequest",
    "ad-pro-transfer-actions:transferAdProRequest", "consulting-actions:createConsultingContract",
    "consulting-actions:requestConsultingValidation", "consulting-actions:decideConsultingContract",
    "consulting-actions:closeConsultingContract", "consulting-actions:addConsultingTask",
    "consulting-actions:toggleConsultingTask", "consulting-actions:deleteConsultingTask",
  ]);
  G("circuit matériel promo (devis→BAT→paiement, étapes après création)", [
    "promo-material-actions:submitQuotes", "promo-material-actions:chooseAgency",
    "promo-material-actions:submitBcForFinance", "promo-material-actions:remindFinance",
    "promo-material-actions:validateBc", "promo-material-actions:confirmBcSent",
    "promo-material-actions:initiatePayment", "promo-material-actions:confirmPayment",
    "promo-material-actions:submitMaterial", "promo-material-actions:directionReview",
    "promo-material-actions:confirmConformity", "promo-material-actions:startBat",
    "promo-material-actions:submitFinalMaterial", "promo-material-actions:recordInvoice",
    "promo-material-actions:settle", "promo-material-actions:addPromoComment",
    "promo-material-actions:cancelPromoMaterial", "promo-circuit-actions:startPromoCircuit",
    "promo-circuit-actions:markQuoteReceived", "promo-circuit-actions:validatePromoStep",
    "promo-circuit-actions:refusePromoStep", "promo-circuit-actions:completePromoTrack",
  ]);
  G("sponsoring / congrès / prises en charge (décisions et étapes après création)", [
    "sponsoring-actions:requestThirdPartyInput", "sponsoring-actions:sponsoringAppeal",
    "sponsoring-actions:cloturerSponsoring", "sponsoring-actions:rouvrirSponsoring",
    "congress-request-actions:requestThirdPartyInput", "congress-request-actions:cancelCongressRequest",
    "congress-beneficiary-actions:addCongressBeneficiary",
    "congress-beneficiary-actions:removeCongressBeneficiary", "congress-beneficiary-actions:requestBeneficiaryIds",
    "care-actions:addCareBeneficiary", "care-actions:setCareOpinion", "care-actions:decideCareBeneficiary",
    "care-actions:removeCareBeneficiary", "care-actions:addCareCell", "care-actions:setCareCellStatus",
    "care-actions:removeCareCell", "care-actions:createCareQuote", "care-actions:decideCareQuote",
    "care-actions:requestCareQuotes", "care-actions:sendCareToFinance",
    "care-actions:linkCareCellPromoMaterial",
  ]);
  G("événements (inscriptions, validation) après création", [
    "event-actions:updateEvent", "event-actions:deleteEvent", "event-actions:submitEventForApproval",
    "event-actions:addRegistration", "event-actions:setRegistrationStatus", "event-actions:deleteRegistration",
  ]);
  G("projets (statut, assignation, messages, archives, liens)", [
    "dossier-actions:updateDossierStatus", "dossier-actions:assignDossier", "dossier-actions:postDossierMessage",
    "dossier-actions:linkEmailToDossier", "dossier-actions:createDossierFromTask",
    "dossier-actions:archiveDossier", "dossier-actions:deleteDossierMessage", "dossier-actions:editDossierMessage",
  ]);
  G("tâches : répondre/faire/valider POUR SOI (accepter la tâche, déposer le travail)", [
    "task-actions:respondTaskRequest", "task-actions:submitTaskWork", "task-actions:reopenTaskWork",
    "task-actions:addTaskComment",
  ]);
  G("demandes administratives avancées (approbations, missions, lots, corbeille propre, validations)", [
    "admin-request-actions:requestApproval", "admin-request-actions:decideApproval",
    "admin-request-actions:toggleMissionStop", "admin-request-actions:updateMission",
    "admin-request-actions:editOwnRequest", "admin-request-actions:corrigerMaDemande",
    "admin-request-actions:deleteOwnRequest", "admin-request-actions:deleteRequests",
    "admin-request-actions:restoreRequest", "admin-request-actions:startRequestProcessing",
    "admin-request-actions:requestFinanceValidation", "admin-request-actions:requestInternalValidation",
    "admin-request-actions:finishRequest", "admin-request-actions:submitAttachmentValidation",
    "admin-request-actions:cancelAttachmentValidation", "mission-actions:assignMission", "mission-actions:removeMission",
    "mission-actions:requestMissionOrder", "mission-actions:issueMissionOrder", "mission-actions:addMissionComment",
    "purchase-request-actions:createPurchaseRequest", "purchase-request-actions:withdrawPurchaseRequest",
    "document-request-actions:requestDocument", "document-request-actions:submitDocumentRequest",
    "document-request-actions:decideDocumentRequest", "document-request-actions:cancelDocumentRequest",
    "stand-in-actions:proposeStandIn", "stand-in-actions:decideStandIn",
  ]);
  G("médical & annuaires (médecins, visites, spécialités, annuaires praticiens, import)", [
    "medical-actions:deleteInstitution", "medical-actions:createSpecialty", "medical-actions:updateSpecialty",
    "medical-actions:deleteSpecialty", "medical-actions:deleteDoctor", "medical-actions:deleteVisit",
    "medical-actions:createDoctor", "medical-actions:updateDoctor", "medical-actions:createVisit",
    "medical-actions:updateVisit", "medical-directory-actions:importDirectorySheet",
    "medical-directory-actions:saveDirectoryCell", "medical-directory-actions:addDirectoryDoctor",
    "medical-directory-actions:deleteDirectoryDoctors", "medical-directory-crud-actions:createMedicalDirectory",
    // La feuille comme un tableur (§118.133) : les colonnes sur mesure s'éditent enfin, et les
    // cellules se colorent — deux gestes d'écran, le second sur une sélection rectangulaire que
    // la conversation n'a pas encore de façon naturelle de désigner.
    "medical-directory-actions:saveDirectoryCustomCell", "annuaire-couleurs-actions:colorerCellulesAnnuaire",
    "medical-directory-crud-actions:updateMedicalDirectory", "medical-directory-crud-actions:deleteMedicalDirectory",
    "medical-directory-crud-actions:moveDoctorsToDirectory", "medical-directory-crud-actions:setDirectoryAccess",
    // Les colonnes propres à un annuaire : Adam ne les pilote pas encore, comme le reste du groupe.
    "medical-directory-crud-actions:createDirectoryColumn", "medical-directory-crud-actions:updateDirectoryColumn",
    "medical-directory-crud-actions:deleteDirectoryColumn",
    "medical-info-actions:requestDocument", "medical-info-actions:cancelDocRequest",
    "medical-info-actions:fulfillDocRequest", "medical-info-actions:recordAuthorityDeclaration",
    "medical-info-actions:validateDeclaration", "medical-info-actions:validateDeclarationByDirection",
    "medical-info-actions:addMedicalInfoComment",
    "field-report-actions:createFieldReport",
    "field-report-actions:updateFieldReport", "field-report-actions:analyzeFieldReportAction",
    "field-report-actions:submitFieldReport", "field-report-actions:validateFieldReport",
    "field-report-actions:reopenFieldReport", "field-report-actions:deleteFieldReport",
    "field-report-actions:deleteFieldReportAttachment",
  ]);
  G("BD / marché / PCH / ventes & prévisions (CRUD des modules commerciaux)", [
    "bd-actions:createBD", "bd-actions:updateBDStatus", "bd-project-actions:createBdProject",
    "bd-project-actions:updateBdProject", "bd-project-actions:deleteBdProject", "bd-project-actions:createBdRange",
    "bd-project-actions:updateBdRange", "bd-project-actions:deleteBdRange", "bd-project-actions:createBdProduct",
    "bd-project-actions:updateBdProduct", "bd-project-actions:deleteBdProduct", "bd-project-actions:updateBdCell",
    "bd-project-actions:addBdProjectComment",
    "market-presentation-actions:generatePresentation", "market-presentation-actions:regeneratePresentation",
    "market-presentation-actions:renamePresentation", "market-presentation-actions:deletePresentation",
    "market-research-actions:createMarketResearch", "market-research-actions:updateMarketResearch",
    "market-research-actions:setMarketResearchParticipants", "market-research-actions:deleteMarketResearch",
    "market-research-actions:addResearchRow", "market-research-actions:updateResearchRow",
    "market-research-actions:deleteResearchRow", "market-research-actions:addResearchPlayer",
    "market-research-actions:updateResearchPlayer", "market-research-actions:deleteResearchPlayer",
    "market-research-actions:prefillResearchRow", "pch-actions:createTender", "pch-actions:updateTender",
    "pch-actions:deleteTender", "pch-actions:createOrder", "pch-actions:updateOrder", "pch-actions:deleteOrder",
    "pch-tender-line-actions:addTenderLine", "pch-tender-line-actions:updateTenderLine",
    "pch-tender-line-actions:deleteTenderLine", "pch-tender-line-actions:analyzeTenderText",
    "pch-tender-line-actions:analyzeTenderDocument", "pch-tender-line-actions:createOrderFromLine",
    "pch-tender-line-actions:enrichTenderLine", "pch-tender-line-actions:enrichAllTenderLines",
    "pch-tender-line-actions:setOrderArrival", "sales-actions:createSale", "sales-actions:importSales",
    "sales-planning-actions:createBusinessUnit",
    "sales-planning-actions:updateBusinessUnit", "sales-planning-actions:deleteBusinessUnit",
    "sales-planning-actions:createPromoProduct", "sales-planning-actions:updatePromoProduct",
    "sales-planning-actions:deletePromoProduct", "sales-planning-actions:saveForecast",
    "sales-planning-actions:saveSfeSettings", "sales-planning-actions:saveTourPlanningSettings",
    "sales-planning-actions:saveRepProfile", "sales-planning-actions:deleteRepProfile",
    "sales-planning-actions:saveAssignment", "sales-planning-actions:deleteAssignment",
    "sales-planning-actions:carryForwardAssignments", "logistics-actions:createLogistics",
    "logistics-actions:updateLogisticsStatus", "delegate-plan-actions:createDelegatePlan",
    "delegate-plan-actions:updateDelegatePlan", "delegate-plan-actions:deleteDelegatePlan",
    "delegate-plan-actions:duplicateDelegatePlan", "product-catalog-actions:linkProductToDossier",
    "product-catalog-actions:unlinkProductFromDossier",
  ]);
  G("stocks hôpitaux (états, instantanés, demandes)", [
    "stock-snapshot-actions:createStockHospital", "stock-snapshot-actions:deleteStockHospital",
    "stock-snapshot-actions:createStockAnnex", "stock-snapshot-actions:deleteStockAnnex",
    "stock-snapshot-actions:requestStockState", "stock-snapshot-actions:recordStockSnapshot",
    "stock-snapshot-actions:deleteStockSnapshot",
  ]);
  G("administration structurelle (entités, gammes, départements, organigramme, contacts, identité)", [
    "company-actions:setCompanyScope", "company-actions:createCompany", "company-actions:updateCompany",
    "company-actions:toggleCompany", "company-access-actions:setCompanyAccess",
    "company-contact-actions:createCompanyContact", "company-contact-actions:updateCompanyContact",
    "company-contact-actions:deleteCompanyContact", "company-identity-actions:saveCompanyIdentity",
    "product-range-actions:createProductRange", "product-range-actions:updateProductRange",
    "product-range-actions:deleteProductRange", "product-range-actions:setProductsRange",
    "product-range-actions:setUserRanges", "product-range-actions:removeProductFromRange",
    "department-actions:createDepartment", "department-actions:updateDepartment", "department-actions:deleteDepartment",
    "department-actions:assignEmployeeDepartment", "department-actions:assignEmployeeManager",
    "org-actions:saveOrgNode", "entity-attach-actions:attachOrphansToCompany",
    "supplier-actions:createSupplier", "supplier-actions:toggleSupplier",
    "supplier-actions:toggleSupplierUser", "settings-actions:setPipelineAccess",
  ]);
  G("matrice d'accès fine & profils (droits par module, périmètres de lignes, profil)", [
    "access-actions:saveAccessMatrix", "access-actions:saveModuleAccess", "access-actions:setRowGrants",
    "access-actions:updateUserProfile",
    "access-actions:requestOnboarding", "access-actions:revokeAllSessions",
  ]);
  // Le rollback rejoue un instantané PAR saveWorkflowDefinition : le Chief couvre le besoin en
  // refournissant les étapes via configure_workflow — le bouton natif est le raccourci d'écran.
  classify("NATIVE", "configure_workflow", ["workflow-actions:saveWorkflowDefinition", "workflow-actions:resetWorkflowDefinition", "workflow-actions:rollbackWorkflowDefinition"]);
  classify("NATIVE", "advance_workflow", ["workflow-actions:advanceWorkflow"]);
  classify("NATIVE", "manage_custom_field", ["custom-field-actions:upsertCustomFieldDef", "custom-field-actions:deleteCustomFieldDef"]);
  G("saisie des VALEURS de champs personnalisés sur une fiche (l'écran de la fiche le fait déjà)", [
    "custom-field-actions:saveCustomValues", "custom-field-actions:modifierChampPersonnalise",
  ]);
  G("règles et demandes de VALIDATION (module Validations)", [
    "validation-actions:createValidationRule", "validation-actions:updateValidationRule",
    "validation-actions:toggleValidationRule", "validation-actions:deleteValidationRule",
    "validation-actions:createValidationRequest", "validation-actions:decideValidation",
    "validation-actions:reviewValidationItem", "validation-actions:clearValidationItem",
    "validation-actions:remindValidator",
  ]);
  G("pièces jointes & documents polymorphes (upload/renommage), papiers en-tête, fournitures", [
    "document-actions:uploadDocument", "document-actions:renameDocument", "document-actions:deleteDocument",
    "letterhead-actions:uploadLetterhead", "letterhead-actions:updateLetterhead", "letterhead-actions:deleteLetterhead",
    "office-supply-actions:createSupplyArticle", "office-supply-actions:updateSupplyArticle",
    "office-supply-actions:toggleSupplyArticle", "office-supply-actions:previewCatalogNormalization",
    "office-supply-actions:applyCatalogNormalization",
  ]);
  G("directives, support, feedback, commentaires génériques, rappels d'écran", [
    "directive-actions:createDirective", "directive-actions:updateDirectiveStatus", "directive-actions:archiveDirective",
    "directive-actions:postDirectiveMessage",
   "support-actions:createSupportRequest", "support-actions:takeSupportRequest",
    "support-actions:answerSupportRequest", "support-actions:updateSupportStatus", "feedback-actions:submitFeedback",
    "feedback-actions:updateFeedbackStatus", "comment-actions:updateComment", "comment-actions:deleteComment",
    "reminder-actions:createReminder", "reminder-actions:completeReminder", "reminder-actions:cancelReminder",
    "reminder-actions:snoozeReminder", "calendar-actions:respondToInvite",
  ]);
  G("cockpit Adventum (seuils de risque) & maintenance profonde de la base", [
    "adventum-actions:updateRiskThresholds",
    "database-admin-actions:purgeOrphanStorage", "database-admin-actions:permanentlyDeleteDriveNode",
    "database-admin-actions:permanentlyDeleteDocument",
    "ai-settings-actions:updateAiSettings", "feature-actions:setFeatureStage",
  ]);

  // ── LA MAIN HUMAINE SUR UNE MISSION D'EXÉCUTION (§33-40) ─────────────────────────────────
  //
  // Trois gestes RÉDUISENT ce qu'une mission va faire — suspendre, reprendre, arrêter — et le
  // refus d'une autorisation en fait autant. Adam les propose par `mission_control`, donc COVERED.
  classify("COVERED", "mission_control (pause / reprise / arrêt / refus d'autorisation / replanification)", [
    "mission-runtime-actions:mettreMissionEnPause",
    "mission-runtime-actions:reprendreMission",
    "mission-runtime-actions:arreterMission",
    // La replanification est COUVERTE et non exclue : elle n'AJOUTE rien de sortant sans accord.
    // Tout ce que le nouveau plan apporte repasse par `reouvrirSiChange` (§8), donc par la
    // personne. Au pire, une injection qui la déclencherait produit une demande d'accord de plus.
    "mission-runtime-actions:replanifierMissionAction",
    /**
     * LA PRIORITÉ est un ORDRE DE PASSAGE, pas une autorisation. Le battement sert les priorités
     * hautes d'abord et l'ancienneté ensuite : relever une mission n'en condamne aucune autre, et
     * une injection qui la déclencherait ferait au pire passer un dossier devant un autre — ce
     * qui se voit sur l'écran du centre, et se remet à zéro d'un clic.
     */
    "mission-runtime-actions:changerPrioriteMission",
    /**
     * MODIFIER UNE MISSION — l'aperçu ne fait que LIRE (`prevoirModification` n'écrit rien), et
     * l'application ne peut RIEN faire sortir : elle invalide des étapes et rouvre des jalons,
     * dont tout ce qui sortirait repasserait par `reouvrirSiChange` (§8), donc par un accord
     * humain. C'est un geste qui RÉDUIT ou RÉORIENTE, jamais un geste qui engage — et il porte
     * la même empreinte bornée que la conversation (§118.48) : une cible reconnue nulle part ne
     * touche à rien.
     */
    "mission-runtime-actions:prevoirModificationMission",
    "mission-runtime-actions:appliquerModificationMission",
    /**
     * LES GESTES DE MASSE (§118.132) — « suspendre toutes mes missions », « arrêter les bloquées » :
     * le confort du bouton, pas une capacité de plus. Chacun rejoue `pause` / `arreter` sur chaque
     * mission de la personne, que `mission_control` propose déjà une par une.
     */
    "mission-runtime-actions:suspendreToutesMesMissions",
    "mission-runtime-actions:arreterMesMissionsBloquees",
  ]);
  /**
   * L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — couvert dans le SEUL sens qu'une conversation
   * a le droit de prendre : POSER (`mission_control` → `suspendre_tout`, direction seulement).
   * LEVER rouvre un moteur et n'existe que par un clic dans les réglages d'Adam (§118.15) — c'est
   * la même asymétrie que `set_mail_policy` face au coupe-circuit sortant, et elle est voulue.
   */
  classify("COVERED", "mission_control (suspendre_tout — sens réducteur seul ; la levée exige l'écran)", [
    "adam-settings-actions:setAdamMissionsPaused",
  ]);
  // La LECTURE de ses accords en attente est la même information que `mission_status` rend déjà.
  classify("COVERED", "mission_status (l'écran d'une mission dit ce qu'elle attend de vous)", [
    "mission-runtime-actions:listerAccordsMission",
  ]);
}
