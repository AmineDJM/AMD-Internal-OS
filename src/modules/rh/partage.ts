/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE RH — LA PORTE PURE (congés, paie, demandes et documents RH, notes de frais, organisation).
 *
 * Importable PARTOUT, navigateur compris : elle ne réexporte que `domaine/` — la fiche de congé, le
 * circuit N+1 → RH → DG, le coût d'une ligne de paie, l'état d'un virement, la fenêtre d'édition
 * d'une note de frais, la ligne hiérarchique. Aucune base, aucun Node, aucun montant déchiffré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Congés : la fiche, le circuit N+1 → RH → DG, la file, l'escalade, les absences d'équipe
export { applyLeaveDecision, canDecideLeave, LEAVE_STAGE_LABELS, type LeaveStage, stageNotifyRoles } from "./domaine/leave-workflow";
export { type AbsenceDEquipe, aujourdhuiAlger, chevauchementsDe, couvreLeJour, jourDuConge, minuitUtc, type PeriodeCommune, periodesCommunes, plusJours } from "./domaine/absences";
export { refusDecisionSurSoi } from "./domaine/decision-sur-soi";

// ── Paie : coût, masse, correction, virement au centre de paiement, rattachement
export { amendImpact, canAmend, resolvedGross, validateAmounts } from "./domaine/payroll-amend";
export { decisionRattachement, phraseRattachement, type SalaireParti } from "./domaine/rattachement-paie";

// ── Demandes et documents RH, notes de frais, attestation de travail, ordre de mission
export { CATEGORIE_DU_DEPOT, HR_APPROVAL_TYPES, HR_DOCUMENT_STATUSES, hrNature, type HrNature } from "./domaine/hr-request-flow";
export { defaultVisibleToEmployee, resolveVisibility, shouldMirrorToDrive, visibilityLabel } from "./domaine/document-visibility";
export { canEditExpenseClaim, EXPENSE_EDIT_MINUTES, expenseAmountError, expenseEditDeadline, expenseEditLabel, type ExpenseEditState } from "./domaine/expense-claim";
export { accords, type ChampsAttestation, type Civilite, CIVILITES, dateCourteFr, dateLongueFr, LIBELLE_PROVENANCE, phraseNaissance, type ProvenanceChamp } from "./domaine/attestation-travail/regles";
export { MODES_TRANSPORT_MISSION, VALEURS_DU_MODELE } from "./domaine/ordre-mission/constantes";

// ── Organisation : ligne hiérarchique, arbre d'équipe, indicateurs, départ
export { type DepartmentNodeLite, type EmployeeNode, managementChainOf, type ManagerSource, managesAnyone, resolveManager } from "./domaine/reporting-line";
export { flattenTree, subtreeOf, type TeamTreeNode } from "./domaine/team-tree";
export { avecLiens, type CommonCounts, commonKpis, JOB_LABEL, type JobCounts, jobKpis, jobOf, type LiensKpi, NO_JOB_KPI_NOTE, type TeamJob, type TeamKpi } from "./domaine/team-kpis";
