/**
 * LES FRANCHISSEMENTS de l'ancien `assistant.ts` vers l'ERP et vers le domaine courrier,
 * regroupés en UN seul point.
 *
 * Le découpage a réparti la boucle en une vingtaine de morceaux ; chacun aurait réimporté
 * Prisma, les droits, les actions canoniques, la politique d'envoi… et les cliquets
 * (`platform/boundary-scan`, `platform/domains`) auraient compté chaque répétition comme une
 * dette nouvelle. Ici : UNE réexportation par module, exactement les modules qu'importait
 * l'original (y compris ceux qu'il importait sans s'en servir) — la dette mesurée reste la même.
 */

// Un SEUL import du schéma : deux déclarations vers le même module comptaient deux
// franchissements de frontière pour une seule dépendance réelle (cf. `platform/boundary-scan`).
export {
  MailSendPolicy, type AdminRequestType, type Priority, type CalendarEventKind, type HrRequestType,
  type RegulatoryCategory,
} from "@prisma/client";
export { prisma } from "@/lib/prisma";
export { companyIdForNew, companyScopedWhere } from "@/lib/company";
export { createWithRetry, referenceDeSerie } from "@/lib/refs";
export { recordAudit } from "@/lib/audit";
export { notifyUser, notifyRoles, broadcastNotification, type BroadcastAudience } from "@/lib/notify";
export { createEventForUser, algiersInputToUtc, CALENDAR_KINDS } from "@/lib/calendar";
export { createDossierRecord } from "@/lib/dossiers-core";
export { envoyerMessageDirect } from "@/lib/messaging";
export { getMailAccount, listMessages, getMessage } from "@/lib/mail";
export {
  userCan, accessibleModules, hasGlobalView, isRegulatorySupervisor, peutPiloterMissionsAdam, peutAnnuaire,
  type Module, scopeMedicalDoctors, scopeRegulatory, scopeAdminRequests,
} from "@/lib/rbac";
export { createLegalDocument, updateLegalDocument } from "@/lib/actions/legal-actions";
export { updateCalendarEvent, deleteCalendarEvent } from "@/lib/actions/calendar-actions";
export {
  setRegulatoryResponsible, setRegulatoryStepState, setRegulatoryPresubOutcome, requestRegulatoryStatusUpdate,
} from "@/lib/actions/regulatory-actions";
export { superAdminDelete, restoreDeletedRecord, destroyDeletedRecord } from "@/lib/actions/admin-delete-actions";
export { toggleUserActive, updateUserRole, setSecondaryRole } from "@/lib/actions/admin-actions";
export { createTaskRecord } from "@/lib/tasks/create-core";
export {
  DELETE_REGISTRY, DELETABLE_KINDS, apercuSuppression, isDeletableKind, type DeletableKind,
} from "@/lib/admin-delete-registry";
export { getCommunicationPolicy, setMailSendPolicy, parseMailPolicyPhrase, POLICY_LABEL, POLICY_HELP } from "@/lib/comms/policy";
export { createOutboundIntent } from "@/lib/comms/outbound";
export { resolveOutboundIdentity, isIdentity, formatIdentity } from "@/lib/comms/identity";
export { classifyReply } from "@/lib/comms/confirmation";
export { approveAndExecuteIntent, solePendingMailIntent, type MailExecutionResult } from "@/lib/comms/approve-execute";
export { findPeople } from "@/lib/directory/resolve";
export { decideAddress, askWhichAddress } from "@/lib/directory/rank";
export { gmailTransport } from "@/lib/google/gmail/transport";
export { requestTreasuryUpdate } from "@/lib/actions/finance-actions";
export { upsertCustomFieldDef, deleteCustomFieldDef } from "@/lib/actions/custom-field-actions";
export { CUSTOM_ENTITY_TYPES } from "@/lib/custom-fields";
export { canSetStructural } from "@/lib/regulatory/structural-fields";
export { isRegStepKey, isRegStepState, isRegPresubOutcome, REG_STEPS, PRESUB_ANSWER_STEP } from "@/lib/regulatory-workflow";
export { createInstitution, updateInstitution } from "@/lib/actions/medical-actions";
export { createStockHospital, createStockAnnex } from "@/lib/actions/stock-snapshot-actions";
export {
  sitsOnPaymentCentre, applyDecision, CENTRAL_STATUS_LABEL, CENTRAL_DECISION_LABEL, PAYMENT_CENTRE_REFUSAL,
  type CentralStatus,
} from "@/lib/payments/authorization";
export { decidePayment } from "@/lib/actions/payment-centre-actions";
export type { CurrentUser } from "@/lib/session";
export { getAppSettings } from "@/lib/settings";
