/**
 * Libellés — MARKETING et PROMOTION MÉDICALE : sponsoring, budget, congrès et événements, terrain,
 * praticiens et établissements, matériel promotionnel, consulting, Ad & Pro, information médicale.
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

export const SPONSORING_STATUS: Record<string, Display> = {
  RECEIVED: { label: "Reçu", tone: "neutral" },
  IN_ANALYSIS: { label: "En analyse", tone: "info" },
  ACCEPTED: { label: "Accepté", tone: "success" },
  REFUSED: { label: "Refusé", tone: "danger" },
  AWAITING_DIRECTION: { label: "Attente Direction", tone: "warning" },
  PAID: { label: "Payé", tone: "success" },
  CLOSED: { label: "Clôturé", tone: "neutral" },
  AWAITING_PRELIMINARY: { label: "Attente National Sales", tone: "warning" },
  // LES DEUX LIBELLÉS DU MILIEU DU CIRCUIT SUIVENT CE QUE LES ÉTAPES FONT AUJOURD'HUI (§118.151).
  // `PRELIMINARY_APPROVED` est l'état projeté aux portes du DG et de la Direction des opérations,
  // `AWAITING_FINAL` celui de l'étape de la Direction Marketing, qui pré-valide la TENUE. Les
  // anciens libellés (« Analyse Direction Marketing », « Attente décision Direction ») décrivaient
  // le circuit d'avant l'inversion : une prose qui contredit le code est pire que pas de prose.
  PRELIMINARY_APPROVED: { label: "En validation (DG / Direction des opérations)", tone: "info" },
  AWAITING_FINAL: { label: "Pré-validation Direction Marketing", tone: "warning" },
  // LA TENUE EST DÉCIDÉE, L'ARGENT NE L'EST PAS ENCORE : les postes se préparent (devis, BC,
  // factures), puis la validation finale les range dans un budget et clôture la demande.
  PRE_VALIDATED: { label: "Tenue pré-validée — postes en cours", tone: "info" },
  APPROVED: { label: "Accordé", tone: "success" },
  // L'APPEL REVIENT À L'ÉTAPE QUI A TRANCHÉ (§118.186) — la Direction Marketing pour la plupart des
  // demandes, la Direction pour celles de la Direction Marketing : le libellé ne nomme plus personne.
  APPEAL_PENDING: { label: "Appel — en réexamen", tone: "purple" },
  AWAITING_FINAL_APPEAL: { label: "Appel — décision Direction", tone: "warning" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
  // RENVOYÉE POUR CORRECTION (§118.186) : chez le demandeur — ni en attente d'un validateur, ni refusée.
  RETURNED: { label: "À corriger — chez le demandeur", tone: "warning" },
};

/**
 * LA NATURE D'UN SPONSORING (§118.151) — choisie à la création, elle décide le poste qui naît avec
 * la demande. Le libellé dit OÙ VA L'ARGENT, parce que c'est ce que la personne doit trancher.
 */
export const SPONSORING_NATURE: Record<"DIRECT" | "INDIRECT", string> = {
  DIRECT: "Direct — versé à l'association",
  INDIRECT: "Indirect — prise en charge de prestations / de médecins",
};

/** Types de sponsoring proposés en menu déroulant (valeur = libellé stocké). */
export const SPONSORING_TYPES: string[] = [
  "Congrès",
  "Séminaire",
  "Table ronde",
  "Formation / Atelier",
  "Webinaire",
  "Symposium",
  "Staff / Réunion de service",
  "Publication / Documentation",
  "Équipement / Matériel",
  "Autre",
];

export const BUDGET_CATEGORY: Record<string, string> = {
  REGULATORY: "Regulatory",
  SPONSORING: "Sponsoring",
  CONGRESS_INTERNATIONAL: "Prises en charge Internationales",
  CONGRESS_NATIONAL: "Prises en charge Nationales",
  MEDICAL_PROMOTION: "Promotion médicale",
  LOGISTICS: "Logistique",
  BUSINESS_DEVELOPMENT: "Business Development",
  MARKETING: "Marketing",
};

export const BUDGET_STATUS: Record<string, Display> = {
  ON_TRACK: { label: "Maîtrisé", tone: "success" },
  AT_RISK: { label: "À surveiller", tone: "warning" },
  OVER_BUDGET: { label: "Dépassé", tone: "danger" },
  CLOSED: { label: "Clôturé", tone: "neutral" },
};

export const CONGRESS_STATUS: Record<string, Display> = {
  CONSIDERED: { label: "Envisagé", tone: "neutral" },
  VALIDATED: { label: "Validé", tone: "info" },
  ORGANIZED: { label: "Organisé", tone: "info" },
  COMPLETED: { label: "Terminé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

export const CONGRESS_REQUEST_STATUS: Record<string, Display> = {
  AWAITING_PRELIMINARY: { label: "Attente National Sales", tone: "warning" },
  // LES DEUX LIBELLÉS DU MILIEU SUIVENT LE CIRCUIT D'AUJOURD'HUI, comme ceux du sponsoring (§118.151,
  // §118.186) : `PRELIMINARY_APPROVED` est projeté aux portes du DG et de la Direction des opérations,
  // `AWAITING_FINAL` à l'étape de la Direction Marketing, qui TRANCHE. « Analyse Direction
  // Marketing » décrivait le circuit d'avant l'inversion et faisait chercher la demande chez
  // quelqu'un qui ne l'avait pas.
  PRELIMINARY_APPROVED: { label: "En validation (DG / Direction des opérations)", tone: "info" },
  AWAITING_FINAL: { label: "Attente décision Direction Marketing", tone: "warning" },
  APPROVED: { label: "Validé — pris en charge", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
  COMPLETED: { label: "Réalisé", tone: "success" },
  RETURNED: { label: "À corriger — chez le demandeur", tone: "warning" },
};

export const NATIONAL_EVENT_TYPE: Record<string, string> = {
  CONGRESS: "Congrès",
  SEMINAR: "Séminaire",
  ROUND_TABLE: "Table ronde",
  WEBINAR: "Webinaire",
  WORKSHOP: "Atelier",
  SYMPOSIUM: "Symposium",
  STAFF: "Staff / réunion service",
  OTHER: "Autre",
};

export const EVENT_TYPE: Record<string, string> = {
  CONGRESS: "Congrès",
  SEMINAR: "Séminaire",
  ROUND_TABLE: "Table ronde",
  HOSPITAL_STAFF: "Staff hospitalier",
  SYMPOSIUM: "Symposium",
  WEBINAR: "Webinaire",
  TRAINING: "Formation",
  SCIENTIFIC_DAY: "Journée scientifique",
  OTHER: "Autre",
};

export const EVENT_SCOPE: Record<string, string> = { NATIONAL: "National", INTERNATIONAL: "International" };
export const EVENT_FORMAT: Record<string, string> = { PRESENTIAL: "Présentiel", WEBINAR: "Webinaire", HYBRID: "Hybride" };

export const EVENT_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  AWAITING_VALIDATION: { label: "Attente validation", tone: "warning" },
  VALIDATED: { label: "Validé", tone: "info" },
  PREPARATION: { label: "En préparation", tone: "info" },
  REGISTRATION_OPEN: { label: "Inscriptions ouvertes", tone: "success" },
  FULL: { label: "Complet", tone: "warning" },
  COMPLETED: { label: "Terminé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

export const PARTICIPANT_ROLE: Record<string, string> = {
  DOCTOR: "Médecin",
  PROFESSOR: "Professeur",
  HEAD_OF_SERVICE: "Chef de service",
  PHARMACIST: "Pharmacien",
  OTHER: "Autre",
};

export const REGISTRATION_STATUS: Record<string, Display> = {
  REGISTERED: { label: "Inscrit", tone: "info" },
  CONFIRMED: { label: "Confirmé", tone: "success" },
  PENDING: { label: "En attente", tone: "warning" },
  REJECTED: { label: "Refusé", tone: "danger" },
  PRESENT: { label: "Présent", tone: "success" },
  ABSENT: { label: "Absent", tone: "neutral" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

export const FIELD_REPORT_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "warning" },
  VALIDATED: { label: "Validé", tone: "success" },
  ARCHIVED: { label: "Archivé", tone: "neutral" },
};

export const VISIT_STATUS: Record<string, Display> = {
  PLANNED: { label: "Prévu", tone: "info" },
  COMPLETED: { label: "Réalisé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
  POSTPONED: { label: "Reporté", tone: "warning" },
};

export const INFLUENCE_LEVEL: Record<string, Display> = {
  LOW: { label: "Faible", tone: "neutral" },
  MEDIUM: { label: "Moyen", tone: "info" },
  HIGH: { label: "Élevé", tone: "warning" },
  KEY_OPINION_LEADER: { label: "Leader d'opinion", tone: "purple" },
};

/** Échelle de segmentation à 5 niveaux (influence / potentiel / affinité). */
export const SEGMENT_LEVEL: Record<string, Display> = {
  VERY_HIGH: { label: "Très haut", tone: "purple" },
  HIGH: { label: "Haut", tone: "success" },
  MEDIUM: { label: "Moyen", tone: "info" },
  LOW: { label: "Bas", tone: "warning" },
  VERY_LOW: { label: "Très bas", tone: "neutral" },
};

export const MEDICAL_SECTOR: Record<string, Display> = {
  HOSPITAL: { label: "Hôpital / Public", tone: "info" },
  LIBERAL: { label: "Libéral / Privé", tone: "purple" },
  BOTH: { label: "Public + Privé", tone: "neutral" },
};

export const INSTITUTION_TYPE: Record<string, string> = {
  CHU: "CHU",
  EPH: "Établissement public hospitalier",
  EHS: "Établissement hospitalier spécialisé",
  CLINIQUE_PRIVEE: "Clinique privée",
  POLYCLINIQUE: "Polyclinique",
  CABINET: "Cabinet médical",
  CENTRE_SANTE: "Centre de santé",
  PHARMACIE: "Pharmacie",
  GROSSISTE: "Grossiste répartiteur",
  AUTRE: "Autre",
};

export const INSTITUTION_SECTOR: Record<string, Display> = {
  PUBLIC: { label: "Public", tone: "info" },
  PRIVE: { label: "Privé", tone: "purple" },
};

export const DOCTOR_TITLE: Record<string, string> = {
  PROFESSEUR: "Professeur",
  MAITRE_CONFERENCES: "Maître de conférences",
  MAITRE_ASSISTANT: "Maître-assistant",
  PRATICIEN_SPECIALISTE: "Praticien spécialiste",
  CHEF_DE_SERVICE: "Chef de service",
  ASSISTANT: "Assistant",
  RESIDENT: "Résident",
  GENERALISTE: "Médecin généraliste",
  PHARMACIEN: "Pharmacien",
  AUTRE: "Autre",
};

/** Préfixe d'affichage devant le nom (Pr. Mouffok, Dr. …). */
export const DOCTOR_TITLE_PREFIX: Record<string, string> = {
  PROFESSEUR: "Pr.",
  MAITRE_CONFERENCES: "Dr.",
  MAITRE_ASSISTANT: "Dr.",
  PRATICIEN_SPECIALISTE: "Dr.",
  CHEF_DE_SERVICE: "Dr.",
  ASSISTANT: "Dr.",
  RESIDENT: "Dr.",
  GENERALISTE: "Dr.",
  PHARMACIEN: "",
  AUTRE: "",
};

/** Nom affiché d'un médecin avec son préfixe de titre (« Pr. Mouffok »). Helper
 *  pur partagé serveur + client (à ne pas exporter depuis un module "use client"). */
export function doctorDisplayName(d: { title: string; name: string }): string {
  const prefix = DOCTOR_TITLE_PREFIX[d.title] ?? "";
  return prefix ? `${prefix} ${d.name}` : d.name;
}

export const PROMO_MATERIAL_STATUS: Record<string, Display> = {
  PROSPECTION_REQUESTED: { label: "Prospection demandée", tone: "warning" },
  QUOTES_UPLOADED: { label: "Devis déposés", tone: "info" },
  AGENCY_CHOSEN: { label: "Agence choisie", tone: "info" },
  // Le code garde son nom historique ; c'est le centre de validation Ad & Pro qui valide (§118.148).
  BC_FINANCE_REVIEW: { label: "BC — au centre de validation Ad & Pro", tone: "warning" },
  BC_VALIDATED: { label: "BC validé", tone: "purple" },
  BC_SENT: { label: "BC transmis à l'agence", tone: "purple" },
  PAYMENT_INITIATED: { label: "Bordereau de paiement", tone: "warning" },
  PAYMENT_DONE: { label: "Paiement effectué", tone: "info" },
  MATERIAL_PRODUCED: { label: "Matériel réalisé", tone: "info" },
  CONFORMITY_REVIEW: { label: "Vérification conformité", tone: "warning" },
  VISA_OBTAINED: { label: "Visa publicitaire obtenu", tone: "purple" },
  BAT_PRINTING: { label: "BAT / impression", tone: "info" },
  FINAL_MATERIAL: { label: "Matériel final", tone: "info" },
  INVOICED: { label: "Facturé", tone: "warning" },
  SETTLED: { label: "Réglé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

/**
 * CONTRAT DE CONSULTING — les cinq états d'une relation avec un prestataire.
 *
 * « Expiré » n'est pas « annulé » : le premier a produit ses effets jusqu'au bout, le second a
 * été rompu. Les confondre, c'est perdre l'historique de la relation — et se tromper le jour où
 * l'on se demande avec qui l'on a déjà travaillé.
 */
export const CONSULTING_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  AWAITING_VALIDATION: { label: "En cours de validation", tone: "warning" },
  ACTIVE: { label: "Actif", tone: "success" },
  EXPIRED: { label: "Expiré", tone: "neutral" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

/** Rythme de la rémunération : 200 000 DZD par mois et 200 000 DZD pour la mission entière ne sont pas la même dépense. */
export const CONSULTING_BILLING: Record<string, string> = {
  ONE_OFF: "Forfait unique",
  MONTHLY: "Mensuel",
  QUARTERLY: "Trimestriel",
  YEARLY: "Annuel",
  ON_DELIVERY: "À la livraison",
};

export const CONSULTING_BILLING_OPTIONS: { value: string; label: string }[] =
  Object.entries(CONSULTING_BILLING).map(([value, label]) => ({ value, label }));

/**
 * DEMANDE « AUTRE » — elle suit le circuit commun depuis le 27/10/2026 (décision #17) : « en cours de
 * validation » jusqu'à la prévalidation de la Direction Marketing (l'étape exacte est sur le panneau du
 * circuit), puis « prévalidée » — les postes se préparent —, puis terminée.
 */
export const AD_PRO_OTHER_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  AWAITING_DECISION: { label: "En cours de validation", tone: "warning" },
  APPROVED: { label: "Prévalidée", tone: "info" },
  REFUSED: { label: "Refusée", tone: "danger" },
  DONE: { label: "Terminée", tone: "success" },
  CANCELLED: { label: "Annulée", tone: "danger" },
  RETURNED: { label: "À corriger", tone: "warning" },
};

/** Ordre de l'ANCIEN circuit (quinze étapes) — ne sert plus qu'aux dossiers d'avant la réforme. */
export const PROMO_MATERIAL_FLOW: string[] = [
  "PROSPECTION_REQUESTED", "QUOTES_UPLOADED", "AGENCY_CHOSEN", "BC_FINANCE_REVIEW", "BC_VALIDATED",
  "BC_SENT", "PAYMENT_INITIATED", "PAYMENT_DONE", "MATERIAL_PRODUCED", "CONFORMITY_REVIEW",
  "VISA_OBTAINED", "BAT_PRINTING", "FINAL_MATERIAL", "INVOICED", "SETTLED",
];

/** Nature du matériel promotionnel (enum MaterialType) — libellés + ordre du menu. */
export const MATERIAL_TYPE: Record<string, string> = {
  PRESENTOIRE: "Présentoir",
  STAND_BOOTH: "Stand / Booth",
  CARNET_BILAN: "Carnet bilan",
  SOUS_MAINS: "Sous-mains",
  BLOC_NOTE: "Bloc-notes",
  SAC_A_DOS: "Sac à dos",
  PORTE_CARTE_RDV: "Porte-carte RDV",
  BANNER: "Banner",
  FICHE_POSO: "Fiche POSO",
  ADV: "ADV",
  FICHE_CONSEILS: "Fiche conseils",
  FICHE_GAMME: "Fiche Gamme",
  POSTER: "Poster",
  VIDEO: "Vidéo",
  CADEAUX_FIN_ANNEE: "Cadeaux fin d'année",
  CARTES_INVITATIONS: "Cartes d'invitations",
  STYLOS: "Stylos",
  CLE_USB: "Clé USB",
  AUTRES: "Autres",
};

/** Options `{ value, label }` du menu « type de matériel » (dans l'ordre métier). */
export const MATERIAL_TYPE_OPTIONS: { value: string; label: string }[] = Object.entries(MATERIAL_TYPE).map(
  ([value, label]) => ({ value, label }),
);

export const MEDICAL_INFO_STATUS: Record<string, Display> = {
  AWAITING_REVIEW: { label: "À déclarer", tone: "warning" },
  DOCS_REQUESTED: { label: "Pièces demandées", tone: "info" },
  READY: { label: "Prêt à valider", tone: "purple" },
  AWAITING_DIRECTION: { label: "Validation Directeur des Opérations", tone: "warning" },
  VALIDATED: { label: "Validé", tone: "success" },
};
