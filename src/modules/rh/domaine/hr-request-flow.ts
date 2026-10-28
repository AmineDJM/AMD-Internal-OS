import type { HrRequestType, HrRequestStatus } from "@prisma/client";

/**
 * Nature d'une demande RH — pilote le workflow, les libellés et les actions afin que
 * l'interface s'adapte à la DEMANDE : un congé/absence n'est pas un document à préparer,
 * c'est une décision à accorder ou refuser.
 */
export type HrNature = "DOCUMENT" | "APPROVAL" | "EXPENSE" | "INTERVIEW";

/** Congés / absences / autorisations : décision Accorder / Refuser (pas de document à remettre). */
export const HR_APPROVAL_TYPES: HrRequestType[] = [
  "ANNUAL_LEAVE", "UNPAID_LEAVE", "SPECIAL_LEAVE", "MATERNITY_LEAVE", "SICK_LEAVE", "EXCEPTIONAL_EXIT",
];

/** Statuts du flux DOCUMENTAIRE (préparer → prête → remise). */
export const HR_DOCUMENT_STATUSES: HrRequestStatus[] = ["PENDING", "IN_PROGRESS", "READY", "DELIVERED", "REJECTED"];

/** Statuts terminaux (demande traitée → archivage « Dossier traité »). */
export const HR_DONE_STATUSES: HrRequestStatus[] = ["READY", "DELIVERED", "APPROVED", "REJECTED"];

/** La catégorie du document RH déposé en réponse à une demande (« Joindre le document & marquer prêt »). */
export const CATEGORIE_DU_DEPOT: Record<string, string> = {
  WORK_CERTIFICATE: "WORK_CERTIFICATE",
  CNAS_CERTIFICATE: "CNAS_CERTIFICATE",
  SALARY_STATEMENT: "SALARY_STATEMENT",
  DOMICILIATION: "DOMICILIATION",
  LEAVE_CERTIFICATE: "OTHER",
  OTHER: "OTHER",
};

/** Détermine la nature d'un type de demande RH. */
export function hrNature(type: HrRequestType): HrNature {
  if (type === "EXPENSE_REPORT") return "EXPENSE";
  if (type === "HR_INTERVIEW") return "INTERVIEW";
  if (HR_APPROVAL_TYPES.includes(type)) return "APPROVAL";
  return "DOCUMENT"; // attestations, relevés, titres, ordre de mission, OTHER…
}
