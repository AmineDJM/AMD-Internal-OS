"use client";

/**
 * LES FORMULAIRES DES RÉGLAGES (`/admin/settings`). Découpé par responsabilité en
 * `admin-settings-forms/` : `limites`, `regulatory`, `communication`, `roles`, `acces` (et `types`).
 * Ce fichier n'est plus que la PORTE qui les réexporte.
 */

export { AdminLimitsForm, AdProDgThresholdForm } from "./admin-settings-forms/limites";
export { RegEnrollmentToggle, RegIntelligenceToggles, RegulatorySupervisorForm, RegulatoryHiddenColumnsForm, RegulatoryTherapeuticSegmentsForm } from "./admin-settings-forms/regulatory";
export { BroadcastComposer, MailDiagnosticPanel } from "./admin-settings-forms/communication";
export { DriveSpaceCreatorForm, PromoMessageAuthorsForm, FieldReportsOverviewForm, OrgChartViewersForm, HiddenModulesForm } from "./admin-settings-forms/roles";
export { PipelineAccessForm, DirectiveAccessForm } from "./admin-settings-forms/acces";
