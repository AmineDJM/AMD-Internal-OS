# 0020 — Inventaire « avant J6 → après » (généré par `npm run capacites:inventaire`, ne pas éditer)

123 gestes que l'Assistant IA offrait avant J6 par Adam (114 ops des cinq outils de domaine, 9 écritures) :
chacun a son équivalent APPELABLE, ouvert à chaque rôle que la porte d'Adam laissait passer (droits par défaut du rôle).
Les lectures empruntées et les outils propres au module figurent dans la décision (§ 4, § 8).

| Avant (Adam) | Geste | Après (capacité · risque, ou outil propre) | Rôles vérifiés |
|---|---|---|---|
| `drive_operation.create_folder` | Nouveau dossier | `drive__createFolder` R1 | 18 |
| `drive_operation.rename` | Renommer | `drive__renameNode` R1 | 18 |
| `drive_operation.move` | Déplacer | `drive__moveNode` R1, `drive__moveNodes` R1 | 18 |
| `drive_operation.share` | Partager | `drive__shareNode` R2, `drive__shareNodeWithMany` R2, `drive__shareNodesWithMany` R2 | 18 |
| `drive_operation.unshare` | Retirer le partage | `drive__unshareNode` R1 | 18 |
| `drive_operation.trash` | Mettre à la corbeille | `drive__trashNode` R4, `drive__trashNodes` R4 | 18 |
| `drive_operation.restore` | Restaurer (corbeille Drive) | `drive__restoreNode` R1 | 18 |
| `drive_operation.delete` | Supprimer définitivement (Drive) | `drive__deleteNode` R4 | 18 |
| `drive_operation.create_office` | Nouveau document (Word/Excel/PowerPoint) | `drive__createOfficeNode` R1 | 18 |
| `drive_operation.to_pdf` | Convertir en PDF | `drive__convertNodeToPdf` R1 | 17 |
| `drive_operation.copy` | Copier vers un dossier | `drive__copyNodes` R1 | 18 |
| `drive_operation.comment` | Commenter un élément | `drive-comment__postDriveComment` R2 | 18 |
| `drive_operation.delete_comment` | Supprimer un commentaire | `drive-comment__deleteDriveComment` R4 | 18 |
| `drive_operation.create_space` | Nouvelle catégorie (espace) | `drive-space__createDriveSpace` R1 | 17 |
| `drive_operation.update_space` | Modifier la catégorie (nom, accès) | `drive-space__updateDriveSpace` R1 | 17 |
| `drive_operation.archive_space` | Archiver / désarchiver la catégorie | `drive-space__archiveDriveSpace` R1 | 17 |
| `drive_operation.delete_space` | Supprimer la catégorie | `drive-space__deleteDriveSpace` R4 | 17 |
| `drive_operation.rename_attachment` | Renommer une pièce jointe d'entité | `document__renameDocument` R1 | 18 |
| `drive_operation.delete_attachment` | Supprimer une pièce jointe d'entité | `document__deleteDocument` R4 | 18 |
| `drive_operation.update_letterhead` | Modifier un papier en-tête | `letterhead__updateLetterhead` R1 | — papier à en-tête : l'action le réserve à l'assistante de direction et à la direction artistique |
| `drive_operation.delete_letterhead` | Supprimer un papier en-tête | `letterhead__deleteLetterhead` R4 | — papier à en-tête : l'action le réserve à l'assistante de direction et à la direction artistique |
| `task_operation.accept` | Accepter la demande de tâche | `task__respondTaskRequest` R2 | 18 |
| `task_operation.refuse` | Refuser la demande de tâche | `task__respondTaskRequest` R2 | 18 |
| `task_operation.delete_task` | Supprimer la tâche | `task__deleteTask` R4 | 18 |
| `task_operation.submit_work` | Valider mon travail | `task__submitTaskWork` R2 | 18 |
| `task_operation.reopen` | Rouvrir la tâche | `task__reopenTaskWork` R1 | 18 |
| `task_operation.request_document` | Demander une pièce à quelqu'un | `document-request__requestDocument` R2 | 18 |
| `task_operation.submit_document_request` | Marquer la pièce transmise | `document-request__submitDocumentRequest` R2 | 18 |
| `task_operation.decide_document_request` | Accepter / refuser la pièce transmise | `document-request__decideDocumentRequest` R4 | 18 |
| `task_operation.cancel_document_request` | Annuler la demande de pièce | `document-request__cancelDocumentRequest` R2 | 18 |
| `task_operation.comment` | Commenter la tâche | `task__addTaskComment` R2 | 18 |
| `regulatory_operation.create_product` | Nouveau dossier réglementaire | `regulatory__createRegulatoryProduct` R2 | 4 |
| `regulatory_operation.set_participants` | Participants du dossier | `regulatory__setRegulatoryParticipants` R1 | 4 |
| `regulatory_operation.add_comment` | Commenter le dossier | `regulatory__addRegulatoryComment` R1 | 5 |
| `regulatory_operation.update_step_details` | Détail d'une étape (dates, note, pièces manquantes) | `regulatory__updateRegulatoryStep` R1 | 4 |
| `regulatory_operation.add_dossier_step` | Ajouter une étape à la frise du dossier | `regulatory-timeline__addDossierStep` R1, `regulatory-timeline__startDossierTimeline` R1 | 4 |
| `regulatory_operation.set_checklist_item` | Checklist de présoumission (cocher un document) | `regulatory__setRegulatoryChecklistItem` R1 | 4 |
| `regulatory_operation.create_variation` | Déposer une variation de fabrication | `regulatory__createVariation` R1 | 4 |
| `regulatory_operation.set_variation_status` | Statut d'une variation (obtenue / en attente / annulée) | `regulatory__setVariationStatus` R1 | 4 |
| `regulatory_operation.request_bv` | Demander un BV (ordre de dépense ANPP) | `regulatory__requestBV` R4 | 4 |
| `regulatory_operation.set_classification` | Entité, segments thérapeutiques & projet BD du dossier | `regulatory__setRegulatoryClassification` R1 | 4 |
| `regulatory_operation.create_supplier` | Nouveau fournisseur | `regulatory__createRegulatorySupplier` R1 | 4 |
| `regulatory_operation.unlock_all` | Déverrouiller TOUS les dossiers | `regulatory__unlockAllRegulatory` R1 | 1 |
| `regulatory_operation.set_step_note` | Note sur une étape de la chronologie | `regulatory__setRegulatoryStepNote` R1 | 4 |
| `regulatory_operation.delete_variation` | Supprimer une variation | `regulatory__deleteVariation` R4 | 4 |
| `regulatory_operation.link_catalog_product` | Rattacher un produit à son dossier | `product-catalog__linkProductToDossier` R1 | 4 |
| `regulatory_operation.unlink_catalog_product` | Défaire un rattachement de catalogue | `product-catalog__unlinkProductFromDossier` R1 | 4 |
| `hr_operation.decide_leave` | Approuver / refuser le congé | `hr__decideLeave` R4 | 18 |
| `hr_operation.cancel_leave` | Annuler le congé | `hr__cancelLeave` R2 | 18 |
| `hr_operation.decide_advance` | Trancher l'avance sur salaire | `hr__decideAdvance` R4 | 2 |
| `hr_operation.set_employee_active` | Activer / désactiver la fiche employé | `hr__setEmployeeActive` R4 | 2 |
| `hr_operation.process_hr_request` | Traiter la demande RH (statut) | `hr-document__processHrRequest` R2 | 2 |
| `hr_operation.decide_expense_report` | Trancher la note de frais | `hr-document__decideExpenseReport` R4 | 2 |
| `hr_operation.decide_training` | Trancher la demande de formation | `training__decideTraining` R4 | 18 |
| `hr_operation.decide_recruitment_step` | Trancher l'étape de recrutement | `recruitment__decideRecruitmentStep` R4 | 18 |
| `hr_operation.create_employee` | Nouvelle fiche employé | `hr__createEmployee` R4 | 2 |
| `hr_operation.update_employee` | Modifier la fiche employé (PATCH — hors salaire) | `hr__updateEmployee` R4 | 2 |
| `hr_operation.update_employee_salary` | Modifier la rémunération (fiche) | `hr__updateEmployee` R4 | 2 |
| `hr_operation.request_leave` | Déposer une demande de congé | `hr__requestLeave` R1 | 18 |
| `hr_operation.update_leave` | Corriger une demande de congé (RH) | `hr__updateLeaveRequest` R1 | 2 |
| `hr_operation.request_advance` | Demander une avance sur salaire | `hr__requestAdvance` R4 | 18 |
| `hr_operation.cancel_advance` | Annuler la demande d'avance | `hr__cancelAdvance` R4 | 18 |
| `hr_operation.comment_hr_request` | Message sur une demande RH | `hr-document__addHrRequestComment` R2 | 18 |
| `hr_operation.decide_hr_leave` | Accorder / refuser une absence (dossier RH) | `hr-document__decideHrLeave` R4 | 2 |
| `hr_operation.ack_expense_originals` | Accuser réception des originaux | `hr-document__ackExpenseOriginals` R2 | 4 |
| `hr_operation.propose_hr_meeting` | Proposer une date d'entrevue | `hr-document__proposeHrMeeting` R2 | 18 |
| `hr_operation.confirm_hr_meeting` | Confirmer l'entrevue | `hr-document__confirmHrMeeting` R2 | 18 |
| `hr_operation.delete_hr_request` | Supprimer une demande RH | `hr-document__deleteHrRequest` R4 | 18 |
| `hr_operation.delete_employee_document` | Supprimer un document du dossier | `hr-document__deleteEmployeeDocument` R4 | 2 |
| `hr_operation.set_employee_document_visibility` | Visibilité d'un document (employé) | `hr-document__setEmployeeDocumentVisibility` R1 | 2 |
| `hr_operation.propose_stand_in` | Désigner l'intérimaire d'un congé | `stand-in__proposeStandIn` R2 | 18 |
| `hr_operation.decide_stand_in` | Valider / refuser l'intérimaire | `stand-in__decideStandIn` R4 | 2 |
| `hr_operation.create_recruitment` | Demander un recrutement | `recruitment__createRecruitmentRequest` R2 | 18 |
| `hr_operation.cancel_recruitment` | Annuler la demande de recrutement | `recruitment__cancelRecruitmentRequest` R2 | 18 |
| `hr_operation.ask_recruitment_info` | Demander une précision (recrutement) | `recruitment__askRecruitmentInfo` R2 | 18 |
| `hr_operation.answer_recruitment_info` | Répondre à la question (recrutement) | `recruitment__answerRecruitmentInfo` R2 | 18 |
| `hr_operation.open_recruitment_sourcing` | Ouvrir le sourcing | `recruitment__openRecruitmentSourcing` R2 | 2 |
| `hr_operation.close_recruitment` | Clore la demande de recrutement | `recruitment__closeRecruitmentRequest` R2 | 18 |
| `hr_operation.add_recruitment_candidate` | Ajouter une candidature | `recruitment__addRecruitmentCandidate` R2 | 18 |
| `hr_operation.move_recruitment_candidate` | Faire avancer un candidat | `recruitment__moveRecruitmentCandidate` R2 | 18 |
| `hr_operation.onboard_recruitment` | Intégrer le recruté (fiche employé) | `recruitment__onboardRecruitment` R1 | 18 |
| `hr_operation.request_training` | Demander une formation | `training__requestTraining` R2 | 18 |
| `hr_operation.create_hr_training` | Organiser une formation (RH) | `training__createHrTraining` R2 | 2 |
| `hr_operation.update_training` | Corriger la formation | `training__updateTraining` R1 | 18 |
| `hr_operation.invite_training_participants` | Inviter / convoquer à la formation | `training__inviteTrainingParticipants` R2 | 2 |
| `hr_operation.respond_training_invitation` | Répondre à l'invitation (formation) | `training__respondToTrainingInvitation` R2 | 18 |
| `task_operation.create_reminder` | Poser un rappel | `reminder__createReminder` R1 | 18 |
| `task_operation.complete_reminder` | Terminer un rappel | `reminder__completeReminder` R1 | 18 |
| `task_operation.cancel_reminder` | Annuler un rappel | `reminder__cancelReminder` R1 | 18 |
| `task_operation.snooze_reminder` | Reporter un rappel | `reminder__snoozeReminder` R1 | 18 |
| `request_operation.request_approval` | Demander une validation hiérarchique | `admin-request__requestApproval` R4 | 18 |
| `request_operation.decide_approval` | Trancher une validation hiérarchique | `admin-request__decideApproval` R4 | 18 |
| `request_operation.toggle_mission_stop` | Cocher un point de passage | `admin-request__toggleMissionStop` R1 | 18 |
| `request_operation.update_mission` | Avancer une course | `admin-request__updateMission` R2 | 18 |
| `request_operation.edit_own_request` | Modifier MA demande | `admin-request__corrigerMaDemande` R1 | 18 |
| `request_operation.delete_own_request` | Retirer MA demande | `admin-request__deleteOwnRequest` R4 | 18 |
| `request_operation.delete_requests` | Supprimer des demandes (motif tracé) | `admin-request__deleteRequests` R4 | 4 |
| `request_operation.restore_request` | Restaurer une demande supprimée | `admin-request__restoreRequest` R1 | 4 |
| `request_operation.start_request_processing` | Commencer le traitement | `admin-request__startRequestProcessing` R2 | 18 |
| `request_operation.request_finance_validation` | Validation Finances (flux achat) | `admin-request__requestFinanceValidation` R1 | 18 |
| `request_operation.request_internal_validation` | Validation interne (hors achat) | `admin-request__requestInternalValidation` R1 | 18 |
| `request_operation.finish_request` | Fin du traitement | `admin-request__finishRequest` R4 | 18 |
| `request_operation.submit_attachment_validation` | Soumettre une pièce à validation | `admin-request__submitAttachmentValidation` R1 | 18 |
| `request_operation.cancel_attachment_validation` | Retirer une validation de pièce | `admin-request__cancelAttachmentValidation` R2 | 18 |
| `request_operation.create_purchase_request` | Demander un achat | `purchase-request__createPurchaseRequest` R4 | 18 |
| `request_operation.withdraw_purchase_request` | Retirer MA demande d'achat | `purchase-request__withdrawPurchaseRequest` R4 | 18 |
| `task_operation.respond_to_calendar_invite` | Répondre à une invitation d'agenda | `calendar__respondToInvite` R2 | 18 |
| `task_operation.update_comment` | Modifier un commentaire | `comment__updateComment` R1 | 18 |
| `task_operation.delete_comment` | Supprimer un commentaire | `comment__deleteComment` R4 | 18 |
| `regulatory_operation.send_update_reminder` | Relance de mise à jour des dossiers | `regulatory-reminder__sendRegulatoryUpdateReminder` R2 | 1 |
| `task_operation.submit_feedback` | Envoyer un feedback | `feedback__submitFeedback` R2 | 18 |
| `task_operation.set_custom_field` | Champ personnalisé d'une fiche | `custom-field__modifierChampPersonnalise` R4 | 18 |
| `task_operation.delete_own_record` | Supprimer mon courrier / document légal | `admin-delete__deleteOwnRecord` R4 | 18 |
| `task_operation.upload_document` | Joindre un fichier à une fiche | `preparer_depot_piece` (outil propre) | 18 |
| `create_task` | Créer une tâche | `task__createTask` R2 | 18 |
| `update_task` | Modifier une tâche (échéance, priorité, responsable, statut, commentaire) | `task__modifierTache` R2, `task__updateTaskStatus` R1, `task__addTaskComment` R2 | 18 |
| `send_message` | Écrire à une personne | `send_message` (outil propre) | porte de l'action |
| `create_hr_request` | Demander un document RH | `hr-document__requestHrDocument` R2 | 18 |
| `create_admin_request` | Demande administrative | `admin-request__createRequest` R2 | 18 |
| `update_regulatory_product` | Modifier un dossier réglementaire | `regulatory__updateRegulatoryProduct` R2, `regulatory__updateRegulatoryStatus` R1, `regulatory__setRegulatoryPriority` R1, `regulatory__setRegulatoryTargetDates` R1, `regulatory__setRegulatoryLock` R1 | porte de l'action |
| `assign_regulatory_responsible` | Désigner le responsable d'un dossier | `regulatory__setRegulatoryResponsible` R2 | porte de l'action |
| `set_regulatory_step` | Régler une étape réglementaire | `regulatory__setRegulatoryStepState` R1, `regulatory__setRegulatoryPresubOutcome` R1 | porte de l'action |
| `request_regulatory_status_update` | Demander un point de statut | `regulatory__requestRegulatoryStatusUpdate` R2 | porte de l'action |
