/**
 * Libellés — RH et ADMINISTRATION : paie, contrats, documents et demandes RH, congés, demandes
 * administratives et leurs approbations, missions (chauffeurs, ordres de mission), agenda.
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

export const PAYROLL_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  VALIDATED: { label: "Validé", tone: "info" },
  PAID: { label: "Payé", tone: "success" },
};

export const CONTRACT_TYPE: Record<string, string> = {
  CDI: "CDI",
  CDD: "CDD",
  INTERIM: "Intérim",
  STAGE: "Stage",
  FREELANCE: "Freelance / Prestation",
  OTHER: "Autre",
};

export const HR_DOCUMENT_CATEGORY: Record<string, string> = {
  CONTRACT: "Contrat de travail",
  AMENDMENT: "Avenant",
  PAYSLIP: "Bulletin de paie",
  WORK_CERTIFICATE: "Attestation de travail",
  CNAS_CERTIFICATE: "Attestation CNAS",
  SALARY_STATEMENT: "Relevé des émoluments",
  DOMICILIATION: "Domiciliation de salaire",
  ID_DOCUMENT: "Pièce d'identité",
  DIPLOMA: "Diplôme",
  MEDICAL: "Certificat médical",
  OTHER: "Autre",
};

export const HR_REQUEST_TYPE: Record<string, string> = {
  WORK_CERTIFICATE: "Attestation de travail",
  CNAS_CERTIFICATE: "Attestation CNAS",
  SALARY_STATEMENT: "Relevé des émoluments",
  DOMICILIATION: "Domiciliation de salaire",
  LEAVE_CERTIFICATE: "Attestation de congé",
  LEAVE_TITLE: "Titre de congé",
  MISSION_ORDER: "Ordre de mission",
  EXPENSE_REPORT: "Note de frais",
  EXCEPTIONAL_EXIT: "Sortie exceptionnelle",
  SICK_LEAVE: "Arrêt maladie",
  ANNUAL_LEAVE: "Demande de congé annuel",
  UNPAID_LEAVE: "Congé sans solde",
  SPECIAL_LEAVE: "Congé exceptionnel (mariage, naissance, décès…)",
  MATERNITY_LEAVE: "Congé de maternité",
  HR_INTERVIEW: "Entrevue avec les RH",
  OTHER: "Autre demande",
};

export const HR_REQUEST_STATUS: Record<string, Display> = {
  PENDING: { label: "Soumise", tone: "warning" },
  IN_PROGRESS: { label: "En préparation", tone: "info" },
  READY: { label: "Prête", tone: "success" },
  DELIVERED: { label: "Remise", tone: "neutral" },
  APPROVED: { label: "Accordée", tone: "success" },
  REJECTED: { label: "Refusée", tone: "danger" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

export const LEAVE_TYPE: Record<string, string> = {
  ANNUAL: "Congé annuel",
  SICK: "Maladie",
  UNPAID: "Sans solde",
  MATERNITY: "Maternité / Paternité",
  SPECIAL: "Événement familial",
  RECOVERY: "Récupération",
  OTHER: "Autre",
};

export const LEAVE_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  APPROVED: { label: "Approuvé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
};

export const ADMIN_REQUEST_TYPE: Record<string, string> = {
  TRAVEL: "Déplacement / Hôtel / Billet",
  MAIL: "Courrier / Document officiel",
  SIGNATURE: "Signature / Cachet / Scan",
  PURCHASE: "Achat interne / Fournitures",
  QUOTE: "Devis fournisseur",
  PAYMENT: "Paiement / Facture",
  DRIVER: "Mission chauffeur", // ne se crée plus (10/2026) — le libellé relit les demandes déjà posées
  GUEST_VISA: "Visa / Professeur / Invité",
  HR_SIMPLE: "Demande RH",
  OTHER: "Autre",
};

export const ADMIN_REQUEST_STATUS: Record<string, Display> = {
  NEW: { label: "Nouvelle", tone: "info" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  AWAITING_VALIDATION: { label: "Attente validation", tone: "warning" },
  // Étapes intermédiaires retirées (Direction, 10/2026) : une demande qui les porte encore se lit « En cours ».
  AWAITING_EXTERNAL: { label: "En cours", tone: "info" },
  AWAITING_PAYMENT: { label: "Attente paiement", tone: "warning" },
  AWAITING_DOCUMENT: { label: "En cours", tone: "info" },
  BLOCKED: { label: "Bloquée", tone: "danger" },
  DONE: { label: "Traitée", tone: "success" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

export const ADMIN_APPROVAL_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  APPROVED: { label: "Validé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  CHANGES_REQUESTED: { label: "Modif. demandée", tone: "info" },
};

export const DRIVER_MISSION_STATUS: Record<string, Display> = {
  NEW: { label: "Nouvelle", tone: "neutral" },
  ACCEPTED: { label: "Acceptée", tone: "info" },
  EN_ROUTE: { label: "En route", tone: "info" },
  DONE: { label: "Terminée", tone: "success" },
  PROBLEM: { label: "Problème", tone: "danger" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

/** Accompagnant ou délégué de référence assigné à une mission. */
export const MISSION_ROLE: Record<string, Display> = {
  ACCOMPAGNANT: { label: "Accompagnant", tone: "info" },
  DELEGATE_REFERENCE: { label: "Délégué de référence", tone: "purple" },
};

/** Statut de l'ordre de mission d'une assignation. */
export const MISSION_ORDER_STATUS: Record<string, Display> = {
  NONE: { label: "Sans ordre de mission", tone: "neutral" },
  REQUESTED: { label: "Ordre demandé", tone: "warning" },
  ISSUED: { label: "Ordre de mission émis", tone: "success" },
};

/** Types d'événements du calendrier (avec couleur de pastille par défaut). */
export const CALENDAR_EVENT_KIND: Record<string, Display & { color: string }> = {
  APPOINTMENT: { label: "Rendez-vous", tone: "info", color: "#2563eb" },
  MEETING: { label: "Réunion", tone: "purple", color: "#7c3aed" },
  REMINDER: { label: "Rappel", tone: "warning", color: "#d97706" },
  DEADLINE: { label: "Échéance", tone: "danger", color: "#dc2626" },
  INFO: { label: "Information", tone: "success", color: "#0891b2" },
  OTHER: { label: "Autre", tone: "neutral", color: "#64748b" },
};

/** Réponse à une invitation. */
export const CALENDAR_INVITE_STATUS: Record<string, Display> = {
  INVITED: { label: "Invité", tone: "neutral" },
  ACCEPTED: { label: "Accepté", tone: "success" },
  DECLINED: { label: "Refusé", tone: "danger" },
  TENTATIVE: { label: "Peut-être", tone: "warning" },
};
