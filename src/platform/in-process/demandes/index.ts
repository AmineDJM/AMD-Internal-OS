/**
 * LE PONT DES DEMANDES — ce qu'Adam (`assistant.ts`) atteint des demandes Ad & Pro, des demandes au secrétariat
 * et des circuits de validation, par UNE porte (frontière Adam ↔ ERP, `src/platform/boundary.test.ts`).
 *
 * Adam ne réécrit aucune règle : il appelle les MÊMES actions que les écrans (création d'une prise en charge par
 * l'action de l'écran — audit ADPRO-04), avec leurs gardes. Les rassembler ici rend la dépendance visible et
 * remplaçable le jour où Adam sortira de l'ERP : un seul fichier à rebrancher sur un contrat de plateforme.
 */
export { createSponsoring } from "@/lib/actions/sponsoring-actions";
export { createEvent } from "@/lib/actions/event-actions";
export { createCongressRequest } from "@/lib/actions/congress-request-actions";
export { updateRequestStatus, assignRequest, addRequestComment } from "@/lib/actions/admin-request-actions";
export { advanceWorkflow, saveWorkflowDefinition, resetWorkflowDefinition } from "@/lib/actions/workflow-actions";
export {
  WORKFLOW_CATEGORIES, CATEGORY_LABELS, CATEGORY_ENTITY, SCOPE_LABELS, POWER_LABELS, ACTOR_SCOPES, WORKFLOW_POWERS,
  type WorkflowCategory, type ActorScope, type WorkflowPower,
} from "@/lib/workflow/types";
