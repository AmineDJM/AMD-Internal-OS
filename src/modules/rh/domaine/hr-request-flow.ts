import type { HrRequestType, HrRequestStatus } from "@prisma/client";
import { HR_REQUEST_STATUS } from "@/lib/labels/rh-administration";

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

/**
 * LE GRAPHE DES STATUTS QUE POSE LE TRAITEMENT RH (`processHrRequest`) — audit sécurité 11/2026. L'action acceptait
 * n'importe quel statut sur n'importe quelle demande : une demande remise se rouvrait, un congé passait « Prête » sans
 * « Accorder » (ni solde, ni règle « jamais sur sa propre demande »), une note de frais se validait sans l'accusé des
 * originaux. Chaque décision a sa porte ; ce traitement-ci ne fait avancer que la PRÉPARATION d'un document.
 *
 * Même statut = enregistrer la note RH sans changer l'état (permis, sauf sur une demande annulée par le salarié).
 */
const SUITES: Record<HrNature, Partial<Record<HrRequestStatus, readonly HrRequestStatus[]>>> = {
  DOCUMENT: { PENDING: ["IN_PROGRESS", "READY", "REJECTED"], IN_PROGRESS: ["READY", "REJECTED"], READY: ["DELIVERED"] },
  // La décision passe par « Valider / Refuser » de la note de frais ; ici, la prise en charge et la remise.
  EXPENSE: { PENDING: ["IN_PROGRESS"], READY: ["DELIVERED"] },
  // « Prête » = date acceptée par l'autre partie (`confirmHrMeeting`) ; les RH peuvent prendre en charge ou refuser.
  INTERVIEW: { PENDING: ["IN_PROGRESS", "REJECTED"], IN_PROGRESS: ["REJECTED"] },
  APPROVAL: {},
};

/** Les statuts qu'un traitement RH peut poser depuis `de`, pour cette nature (hors note seule). */
export function suitesTraitementRh(nature: HrNature, de: HrRequestStatus): readonly HrRequestStatus[] {
  return SUITES[nature][de] ?? [];
}

const libelle = (s: HrRequestStatus): string => HR_REQUEST_STATUS[s]?.label ?? s;

/** `null` si le passage `de` → `vers` est permis au traitement RH ; sinon le refus, en français, avec le remède. */
export function refusTransitionDemandeRh(nature: HrNature, de: HrRequestStatus, vers: HrRequestStatus): string | null {
  if (de === "CANCELLED") return "Le salarié a annulé cette demande : elle ne se modifie plus. Pour lui écrire, utilisez le fil de la demande.";
  if (de === vers) return null;
  if (suitesTraitementRh(nature, de).includes(vers)) return null;
  if (nature === "APPROVAL") {
    return "Un congé ou une absence se tranche par « Accorder » ou « Refuser » : c'est là que le solde et la règle « jamais sur sa propre demande » s'appliquent.";
  }
  if (nature === "EXPENSE" && (vers === "READY" || vers === "REJECTED")) {
    return "Une note de frais se tranche par « Valider » ou « Refuser » de la note : l'accusé des originaux et le mois d'imputation s'y contrôlent.";
  }
  if (nature === "INTERVIEW" && vers === "READY") {
    return "Une entrevue est prête quand sa date est acceptée : proposez une date, l'autre partie la confirme.";
  }
  if (vers === "CANCELLED") return "Seul le salarié annule sa demande. Pour l'écarter, refusez-la avec un motif.";
  if (vers === "APPROVED") return "« Accordée » est la décision d'un congé ou d'une absence, pas l'état d'un document.";
  const suites = suitesTraitementRh(nature, de);
  return `Passage « ${libelle(de)} » → « ${libelle(vers)} » impossible. `
    + (suites.length ? `Depuis « ${libelle(de)} », la demande peut passer à : ${suites.map((s) => `« ${libelle(s)} »`).join(", ")}.` : `« ${libelle(de)} » est un état final : pour un nouveau besoin, le salarié fait une nouvelle demande.`);
}
