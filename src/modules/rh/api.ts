/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE RH — LA PORTE SERVEUR (congés, paie, avances, notes de frais, documents RH, organisation).
 *
 * Hors de `src/modules/rh/`, on importe CE fichier (ou `./partage` pour les règles pures, ou les
 * fichiers d'actions), jamais `domaine/` ni `infra/` : tenu par ESLint et `src/modules/frontieres.test.ts`.
 *
 * Tables possédées : `Employee` (fiche RH), `LeaveRequest`, `SalaryAdvance`, `PayrollEntry`, `PayrollWire`,
 * `HrDocumentRequest` (demandes, notes de frais, entrevues), `EmployeeDocument`.
 *
 * Ce que la porte ne fait PAS :
 *   - elle ne DÉCHIFFRE rien : salaires, IBAN et NIN se lisent par `@/modules/coffre/api-lecture`,
 *     depuis les pages RH seulement (une action, que l'assistant peut appeler, n'écrit que) ;
 *   - elle ne PAIE pas : la paie part au centre de paiement (Finances) comme une demande, et c'est
 *     le règlement de l'ordre qui rappelle `solderVirementPaie` (fait du virement, masse salariale) ;
 *   - les droits délégués d'un absent (`lib/hr/stand-in*`) et « qui voit les salaires »
 *     (`lib/hr/confidentialite`) restent au socle des droits : `rbac.ts` et le coffre les lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";

// ── Congés : la fiche, le circuit N+1 → RH → DG, la file, l'escalade, les absences d'équipe
export { attachLeaveFiles, createLeaveRequest, HR_TYPE_TO_LEAVE, hrTypeIsLeave, leaveDecider, revalidateLeaveViews } from "./infra/leave-core";
export { leaveFormContext } from "./infra/leave-form-context";
export { remonterConge, trancherSousEscalade } from "./infra/conge-escalade";

// ── Paie : coût, masse, correction, virement au centre de paiement, rattachement
export { chargerSalairesPartis } from "./infra/salaires-partis";

// ── Demandes et documents RH, notes de frais, attestation de travail, ordre de mission
export { estEtatRhTraite, marquerDemandeRhTraitee } from "./infra/hr-demande-traitee";
export { archiveHrRequestIfDone } from "./infra/archive-demande-rh";
export { mirrorEmployeeContractToDrive } from "./infra/hr-drive-mirror";
export { genererEtRemettreAttestation, type PreparationAttestation, preparerAttestationTravail } from "./infra/attestation-travail-depot";
export { remplirOrdreDeMission } from "./infra/ordre-mission/modele";
export { genererEtRemettreOrdreDeMission, referenceOrdreMissionSuggeree, societeDeLOrdreDeMission } from "./infra/ordre-mission-depot";

// ── Organisation : ligne hiérarchique, arbre d'équipe, indicateurs, départ
export { compteSuitLaFiche } from "./infra/depart";

// ── Lectures des écrans
export { getLeavesToDecide, getMyLeaveRequests, getMyWorkspace, getRhData } from "./infra/requetes/hr";
export { getEmployeeHrDossier, getHrRequestQueue, getHrRequestsPretes, getMyHrDossier, type HrDocumentDTO, type HrQueueItem, type HrRequestDTO } from "./infra/requetes/hr-documents";
export { getHrPulse } from "./infra/requetes/hr-pulse";
export { complementsConges, discussionsDesConges } from "./infra/requetes/conges-discussion";
