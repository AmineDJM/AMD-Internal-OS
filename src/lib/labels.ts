import type { AnnuaireAccordable } from "./annuaires/acces";
import type { Action, Module } from "./rbac";
import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "./chemins/stock-promo";
import { CHEMIN_BONS_DE_COMMANDE } from "./chemins/bons-de-commande";
import { CHEMIN_RAPPORTS_TERRAIN } from "./chemins/rapports-terrain";

/**
 * Centralised French display labels and badge tones for every enum value.
 * `tone` maps to the <Badge> component variants.
 */

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "purple";

interface Display {
  label: string;
  tone: BadgeTone;
}

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  // « DIRECTION DES OPÉRATIONS » — rétabli sur décision de la Direction (09/2026). Le libellé
  // avait été raccourci en « Direction » par crainte d'une confusion avec le Directeur des
  // Opérations, devenu un rôle à part. La crainte était fondée et le remède était trop large :
  // ce sont DEUX vocabulaires, jamais confondus (§118.112a) — « Direction des opérations » nomme
  // un SERVICE, « Directeur des Opérations » nomme une PERSONNE, et c'est le service qui tranche
  // les demandes Ad&Pro. Ce qui protège désormais du doublon n'est pas un libellé amputé mais un
  // FAIT vérifié : `role-labels.test.ts` exige que les 19 libellés soient distincts deux à deux,
  // y compris après normalisation (casse, accents, espaces). Une garde mesurée vaut mieux qu'un
  // mot qu'on rogne — le mot rogné, lui, ne disait plus ce que le métier appelle ce service.
  DIRECTION: "Direction des opérations",
  GENERAL_MANAGER: "Directeur Général",
  OPERATIONS_DIRECTOR: "Directeur des Opérations",
  HEAD_OF_REGULATORY: "Responsable Réglementaire",
  REGULATORY_ASSISTANT: "Assistante Réglementaire",
  HEAD_OF_SALES: "Responsable Ventes",
  SALES_USER: "Commercial",
  LOGISTICS_MANAGER: "Responsable Logistique",
  MEDICAL_PROMOTION_MANAGER: "Manager Promotion Médicale",
  MEDICAL_DELEGATE: "Délégué Médical",
  NATIONAL_SALES: "National Sales",
  // « Chef de produit » renommé DIRECTION MARKETING (décision de la Direction, 09/2026) : le
  // rôle arbitre désormais le budget Ad&Pro et le choix de la sous-catégorie budgétaire.
  PRODUCT_MANAGER: "Direction Marketing",
  BUSINESS_DEVELOPMENT_MANAGER: "Manager Business Development",
  FINANCE_BUDGET_MANAGER: "Responsable Finance / Budget",
  MEDICAL_INFO_PHARMACIST: "Pharmacien resp. information médicale",
  DIRECTION_ASSISTANT: "Assistante de Direction",
  COORDINATOR: "Coordination / Coursier",
  VIEWER: "Lecteur",
};

export const PRIORITY: Record<string, Display> = {
  LOW: { label: "Basse", tone: "neutral" },
  MEDIUM: { label: "Moyenne", tone: "info" },
  HIGH: { label: "Haute", tone: "warning" },
  CRITICAL: { label: "Critique", tone: "danger" },
};

export const REGULATORY_CATEGORY: Record<string, Display> = {
  MEDICINE: { label: "Médicament", tone: "info" },
  MEDICAL_DEVICE: { label: "Dispositif médical", tone: "purple" },
};

export const SALE_TYPE: Record<string, Display> = {
  PRODUCT: { label: "Produit", tone: "info" },
  SERVICE: { label: "Service", tone: "purple" },
};

/** Formes galéniques (menu déroulant des dossiers Regulatory). */
export const PHARMA_FORM: Record<string, string> = {
  COMPRIME: "Comprimé",
  COMPRIME_PELLICULE: "Comprimé pelliculé",
  GELULE: "Gélule",
  CAPSULE_MOLLE: "Capsule molle",
  SIROP: "Sirop",
  SUSPENSION_BUVABLE: "Suspension buvable",
  SOLUTION_BUVABLE: "Solution buvable",
  SOLUTION_INJECTABLE: "Solution injectable",
  POUDRE_INJECTABLE: "Poudre pour solution injectable",
  PERFUSION: "Solution pour perfusion",
  POMMADE: "Pommade",
  CREME: "Crème",
  GEL: "Gel",
  SUPPOSITOIRE: "Suppositoire",
  OVULE: "Ovule",
  COLLYRE: "Collyre",
  SPRAY_NASAL: "Spray nasal",
  AEROSOL: "Aérosol / Inhalateur",
  PATCH: "Patch transdermique",
  POUDRE_ORALE: "Poudre orale",
  GOUTTES: "Gouttes",
  AUTRE: "Autre",
};

/** Unités de dosage. */
export const DOSAGE_UNIT: Record<string, string> = {
  MG: "mg",
  G: "g",
  MCG: "µg",
  UI: "UI",
  PERCENT: "%",
  MG_ML: "mg/ml",
  MG_G: "mg/g",
  ML: "ml",
  MEQ: "mEq",
  MMOL: "mmol",
};

/** Catalogue Achats : catégories d'articles de fourniture de bureau. */
export const SUPPLY_CATEGORY: Record<string, string> = {
  PAPETERIE: "Papeterie",
  INFORMATIQUE: "Informatique & bureautique",
  MOBILIER: "Mobilier",
  CONSOMMABLE: "Consommables (encre, papier…)",
  CUISINE: "Cuisine & café",
  ENTRETIEN: "Entretien & hygiène",
  ELECTRIQUE: "Électrique & accessoires",
  AUTRE: "Autre",
};

/** Catalogue Achats : unités de conditionnement. */
export const SUPPLY_UNIT: Record<string, string> = {
  PIECE: "Pièce",
  BOITE: "Boîte",
  PAQUET: "Paquet",
  RAME: "Rame",
  CARTON: "Carton",
  LOT: "Lot",
  ROULEAU: "Rouleau",
  LITRE: "Litre",
  KG: "Kg",
};

export const PRODUCT_TYPE: Record<string, string> = {
  IMPORTED: "Importé",
  LOCALLY_MANUFACTURED: "Fabriqué localement",
  TOLL_MANUFACTURING: "Façonnage",
  BIOSIMILAR: "Biosimilaire",
  GENERIC: "Générique",
  ORIGINATOR: "Princeps",
};

export const REGULATORY_STATUS: Record<string, Display> = {
  PRE_SUBMISSION: { label: "Pré-soumission", tone: "neutral" },
  IN_PREPARATION: { label: "Préparation dossier", tone: "info" },
  SUBMITTED: { label: "Déposé", tone: "info" },
  AWAITING_BV_PAYMENT: { label: "Attente paiement BV", tone: "warning" },
  AWAITING_ANPP: { label: "Attente ANPP", tone: "warning" },
  RESPONDING_TO_QUERIES: { label: "Réponse aux réserves", tone: "warning" },
  DECISION_OBTAINED: { label: "Décision obtenue", tone: "success" },
  BLOCKED: { label: "Bloqué", tone: "danger" },
  CLOSED: { label: "Clôturé", tone: "success" },
};

/** Statut SIMPLIFIÉ visible par le fournisseur dans le portail externe. */
export const EXTERNAL_REGULATORY_STATUS: Record<string, Display> = {
  IN_PREPARATION: { label: "Dossier en préparation", tone: "info" },
  SUBMITTED: { label: "Dossier déposé", tone: "info" },
  UNDER_REVIEW: { label: "En cours d'examen", tone: "warning" },
  INFO_REQUESTED: { label: "Compléments demandés", tone: "warning" },
  APPROVED: { label: "Enregistrement obtenu", tone: "success" },
  ON_HOLD: { label: "En attente", tone: "neutral" },
  CLOSED: { label: "Clôturé", tone: "neutral" },
};

export const STEP_STATUS: Record<string, Display> = {
  NOT_STARTED: { label: "Non commencé", tone: "neutral" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  DONE: { label: "Terminé", tone: "success" },
  BLOCKED: { label: "Bloqué", tone: "danger" },
  LATE: { label: "En retard", tone: "warning" },
};

export const REGULATORY_STEP_TYPE: Record<string, string> = {
  PRE_SUBMISSION: "Pré-soumission",
  CTD_PREPARATION: "Préparation dossier CTD",
  DOSSIER_REVIEW: "Vérification dossier",
  DOSSIER_SUBMISSION: "Dépôt dossier",
  BV1_PAYMENT: "Paiement 1er BV",
  BV1_RECEIPT: "Réception 1er BV",
  BV2_PAYMENT: "Paiement 2ème BV",
  BV2_RECEIPT: "Réception 2ème BV",
  BV3_PAYMENT: "Paiement 3ème BV",
  BV3_RECEIPT: "Réception 3ème BV",
  QUERY_RESPONSE: "Réponse aux réserves",
  COMPLEMENTS_REQUESTED: "Compléments demandés",
  COMPLEMENTS_SUBMITTED: "Compléments déposés",
  COMMISSION_REVIEW: "Passage commission",
  REGISTRATION_DECISION: "Décision d'enregistrement",
  AMM_RECEIVED: "AMM reçue",
  DOSSIER_CLOSED: "Dossier clôturé",
};

/**
 * LA FRISE D'UN DOSSIER — le VOCABULAIRE, et lui seul.
 *
 * Les RÈGLES (ce qui s'ajoute, ce qui se supprime, où l'on insère) vivent dans
 * `lib/regulatory/dossier-timeline.ts`, qui reprend ces deux constantes en les typant : une
 * seule source pour les mots, une seule source pour les règles. Ils sont ici parce que trois
 * lecteurs doivent en dire exactement la MÊME chose — l'écran du dossier, le journal d'audit,
 * et Adam quand il propose d'ajouter une étape.
 */
export const DOSSIER_STEP_KIND: Record<string, string> = {
  CTD_INITIAL: "CTD initial",
  ANPP_RESERVES: "Réserves ANPP",
  ANPP_RESPONSE: "Réponse aux réserves",
  CTD_VERSION: "Version du CTD",
  DECISION: "Décision de l'agence",
  OTHER: "Autre",
};

/** Ce que propose le « + », dans l'ordre où cela arrive dans la vie d'un dossier. L'ORIGINE
 *  (`CTD_INITIAL`) n'y est pas : elle existe déjà — le refus, lui, est une règle testée. */
export const DOSSIER_STEP_ADDABLE: string[] = [
  "ANPP_RESERVES", "ANPP_RESPONSE", "CTD_VERSION", "DECISION", "OTHER",
];

/** Ordered list of regulatory steps used when seeding & rendering timelines. */
export const REGULATORY_STEP_ORDER: string[] = [
  "PRE_SUBMISSION",
  "CTD_PREPARATION",
  "DOSSIER_REVIEW",
  "DOSSIER_SUBMISSION",
  "BV1_PAYMENT",
  "BV1_RECEIPT",
  "BV2_PAYMENT",
  "BV2_RECEIPT",
  "BV3_PAYMENT",
  "BV3_RECEIPT",
  "QUERY_RESPONSE",
  "COMPLEMENTS_REQUESTED",
  "COMPLEMENTS_SUBMITTED",
  "COMMISSION_REVIEW",
  "REGISTRATION_DECISION",
  "AMM_RECEIVED",
  "DOSSIER_CLOSED",
];

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

export const PAYMENT_STATUS: Record<string, Display> = {
  UNPAID: { label: "Non payé", tone: "warning" },
  PARTIAL: { label: "Partiel", tone: "info" },
  PAID: { label: "Payé", tone: "success" },
  OVERDUE: { label: "En retard", tone: "danger" },
};

export const DELIVERY_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "neutral" },
  IN_TRANSIT: { label: "En transit", tone: "info" },
  DELIVERED: { label: "Livré", tone: "success" },
  RETURNED: { label: "Retourné", tone: "danger" },
};

export const LOGISTICS_STATUS: Record<string, Display> = {
  ORDERED: { label: "Commandé", tone: "neutral" },
  PRODUCTION: { label: "Production", tone: "info" },
  SHIPPED: { label: "Expédié", tone: "info" },
  ARRIVED_TERMINAL: { label: "Arrivé port/aéroport", tone: "warning" },
  CUSTOMS: { label: "Dédouanement", tone: "warning" },
  DELIVERED: { label: "Livré", tone: "success" },
  BLOCKED: { label: "Bloqué", tone: "danger" },
};

export const PCH_TENDER_STATUS: Record<string, Display> = {
  NOT_STARTED: { label: "Pas encore commencé", tone: "neutral" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  COMPLETED: { label: "Terminé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
  SUSPENDED: { label: "Suspendu", tone: "warning" },
  LOST: { label: "Perdu", tone: "danger" },
};

/**
 * LE NIVEAU DÉRIVÉ d'un marché (Market 360°). Distinct du statut STOCKÉ ci-dessus : le statut
 * est ce qu'un humain a décidé (annulé, suspendu…), le niveau est ce que les FAITS racontent —
 * calculé par `lib/pch/market-math.ts` (même doctrine que le niveau de process Regulatory).
 */
export const PCH_MARKET_NIVEAU: Record<string, Display> = {
  BROUILLON: { label: "Brouillon", tone: "neutral" },
  PREPARATION: { label: "En préparation", tone: "info" },
  SOUMIS: { label: "Soumis", tone: "info" },
  PERDU: { label: "Perdu", tone: "danger" },
  CONTRACTUALISATION: { label: "Attribué — contrat à enregistrer", tone: "warning" },
  EXECUTION: { label: "En exécution", tone: "success" },
  CLOTURE: { label: "Clôturé", tone: "neutral" },
  ANNULE: { label: "Annulé", tone: "danger" },
  SUSPENDU: { label: "Suspendu", tone: "warning" },
};

/** Le RÉSULTAT d'un lot d'appel d'offres (§14) — cinq issues, plus les états de préparation. */
export const PCH_LINE_STATUS: Record<string, Display> = {
  PENDING: { label: "À étudier", tone: "neutral" },
  QUOTED: { label: "Chiffré", tone: "info" },
  SUBMITTED: { label: "Soumissionné", tone: "info" },
  WON: { label: "Gagné", tone: "success" },
  LOST: { label: "Perdu", tone: "danger" },
  UNSUCCESSFUL: { label: "Infructueux", tone: "warning" },
  CANCELLED: { label: "Lot annulé", tone: "neutral" },
};

export const PCH_ORDER_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  VALIDATED: { label: "Validé", tone: "info" },
  DELIVERED: { label: "Livré", tone: "success" },
  PAID: { label: "Payé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

export const STOCK_DIRECTION: Record<string, Display> = {
  IN: { label: "Entrée", tone: "success" },
  OUT: { label: "Sortie", tone: "danger" },
  ADJUST: { label: "Ajustement", tone: "neutral" },
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

// LE TERRAIN — officine de ville, secteur hospitalier, ou les deux.
//
// Le MÊME vocabulaire sert au produit (son canal de distribution) et à la Business Unit (le
// terrain qu'elle couvre) : deux jeux de mots pour un seul énuméré divergent à la première
// retouche, et « Ville » d'un côté contre « Gamme de ville » de l'autre fait douter qu'il
// s'agisse de la même chose. `lib/sfe-setup.ts` en dérive ses libellés.
export const PRODUCT_CHANNEL: Record<string, Display> = {
  RETAIL: { label: "Gamme de ville", tone: "purple" },
  HOSPITAL: { label: "Hospitalière", tone: "info" },
  BOTH: { label: "Ville + Hôpital", tone: "neutral" },
};

/**
 * LE CYCLE DE VIE D'UN PRODUIT CANONIQUE (§118.178) — distinct du statut réglementaire d'un
 * dossier : « enregistré » se DÉDUIT des dossiers (une décision obtenue), « commercialisé » et
 * « arrêté » sont des décisions humaines qu'aucun statut de dossier ne contredit.
 */
export const PRODUCT_LIFECYCLE: Record<string, Display> = {
  STUDY: { label: "À l'étude", tone: "neutral" },
  REGISTERED: { label: "Enregistré", tone: "success" },
  MARKETED: { label: "Commercialisé", tone: "info" },
  DISCONTINUED: { label: "Arrêté", tone: "warning" },
};

// Demandes de l'information médicale (PRIM) → Regulatory.
export const REG_REQUEST_STATUS: Record<string, Display> = {
  OPEN: { label: "Ouverte", tone: "info" },
  IN_PROGRESS: { label: "En cours", tone: "warning" },
  ANSWERED: { label: "Répondue", tone: "success" },
  CLOSED: { label: "Clôturée", tone: "neutral" },
};

export const REG_REQUEST_CATEGORY: Record<string, string> = {
  QUESTION: "Question réglementaire",
  DOCUMENT: "Demande de document",
  STATUS_UPDATE: "Point statut d'enregistrement",
  VARIATION: "Variation / modification",
  OTHER: "Autre",
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

export const BD_TYPE: Record<string, string> = {
  GENERIC: "Générique",
  BIOSIMILAR: "Biosimilaire",
  ORIGINATOR: "Princeps",
  LICENSE: "Licence",
  DISTRIBUTION: "Distribution",
  TOLL_MANUFACTURING: "Façonnage",
};

export const BD_STATUS: Record<string, Display> = {
  IDEA: { label: "Idée", tone: "neutral" },
  RESEARCH: { label: "Recherche", tone: "info" },
  CONTACTED: { label: "Contacté", tone: "info" },
  NDA: { label: "NDA", tone: "purple" },
  OFFER_RECEIVED: { label: "Offre reçue", tone: "warning" },
  NEGOTIATION: { label: "Négociation", tone: "warning" },
  VALIDATED: { label: "Validé", tone: "success" },
  ABANDONED: { label: "Abandonné", tone: "danger" },
};

/** Statuts stratégiques d'un projet Business Development (Projet → Gamme → Produit). */
export const BD_PROJECT_STATUS: Record<string, Display> = {
  IDEA: { label: "Idée", tone: "neutral" },
  TO_ANALYZE: { label: "À analyser", tone: "info" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  AWAITING_SUPPLIER: { label: "En attente fournisseur", tone: "warning" },
  AWAITING_INTERNAL: { label: "En attente interne", tone: "warning" },
  RECOMMENDATION_READY: { label: "Recommandation prête", tone: "purple" },
  VALIDATED: { label: "Validé", tone: "success" },
  ABANDONED: { label: "Abandonné", tone: "danger" },
  CLOSED: { label: "Clôturé", tone: "neutral" },
};

export const BD_SOURCING: Record<string, string> = {
  MANUFACTURED: "Fabriqué",
  IMPORTED: "Importé",
  TO_STUDY: "À étudier",
};

export const DOCUMENT_CATEGORY: Record<string, string> = {
  CTD_FULL: "CTD complet",
  MODULE_1: "Module 1",
  MODULE_2: "Module 2",
  MODULE_3: "Module 3",
  MODULE_4: "Module 4",
  MODULE_5: "Module 5",
  GMP_CERTIFICATE: "Certificat GMP",
  CPP: "CPP",
  ORIGIN_AMM: "AMM pays d'origine",
  SUBMISSION_LETTER: "Lettre de soumission",
  BV_RECEIPT: "Reçu de paiement BV",
  QUERY_RECEIVED: "Réserves reçues (ANPP)",
  QUERY_RESPONSE: "Réponse aux réserves",
  REGISTRATION_DECISION: "Décision d'enregistrement",
  PROFORMA: "Proforma",
  INVOICE: "Facture / Invoice",
  PACKING_LIST: "Packing list",
  BL_AWB: "BL / AWB",
  ANALYSIS_CERTIFICATE: "Certificat d'analyse",
  ORIGIN_CERTIFICATE: "Certificat d'origine",
  CUSTOMS_DOCS: "Documents douane",
  DELIVERY_NOTE: "Bon de livraison",
  RECEPTION_REPORT: "PV de réception",
  REQUEST_LETTER: "Lettre de demande",
  PROGRAM: "Programme",
  QUOTE: "Devis",
  CONVENTION: "Convention",
  SUPPORTING_DOC: "Justificatif",
  PHOTO: "Photo",
  PRESENTATION: "Présentation",
  POST_EVENT_REPORT: "Rapport post-événement",
  SUPPLIER_OFFER: "Offre fournisseur",
  PURCHASE_ORDER: "Bon de commande",
  PAYMENT_SLIP: "Bordereau de paiement",
  PAYMENT_RECEIPT: "Quittance / reçu",
  PROMO_MATERIAL_FILE: "Matériel promotionnel",
  AD_VISA: "Visa publicitaire",
  ID_DOCUMENT: "Pièce d'identité",
  MISSION_ORDER: "Ordre de mission",
  OTHER: "Autre",
};

export const CONFIDENTIALITY: Record<string, Display> = {
  INTERNAL: { label: "Interne", tone: "neutral" },
  RESTRICTED: { label: "Restreint", tone: "warning" },
  CONFIDENTIAL: { label: "Confidentiel", tone: "danger" },
};

export const FINANCE_DIRECTION: Record<string, Display> = {
  IN: { label: "Encaissement", tone: "success" },
  OUT: { label: "Décaissement", tone: "danger" },
};

export const FINANCE_CATEGORY: Record<string, string> = {
  RECETTE: "Recette / Vente",
  CCA: "Compte courant associé",
  PRET: "Emprunt reçu",
  REMBOURSEMENT: "Remboursement emprunt",
  SALAIRE: "Salaires / Personnel",
  AVANCE: "Avance sur salaire",
  LOYER: "Loyer",
  VOYAGE: "Voyages / Déplacements",
  EVENEMENT: "Événement / Table ronde",
  BUREAUTIQUE: "Bureautique / Mobilier",
  FOURNISSEUR: "Achats fournisseurs",
  CHARGES: "Charges (élec, eau, internet…)",
  IMPOT: "Impôts & taxes",
  BANQUE: "Frais bancaires",
  AUTRE: "Autre",
};

export const FINANCE_METHOD: Record<string, string> = {
  CASH: "Espèces",
  BANK_TRANSFER: "Virement",
  CHEQUE: "Chèque",
  CARD: "Carte",
  OTHER: "Autre",
};

export const FINANCE_STATUS: Record<string, Display> = {
  PENDING: { label: "Prévu", tone: "warning" },
  SETTLED: { label: "Réalisé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

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

/** Variation d'enregistrement (Regulatory) : passage en fabrication locale. */
export const MANUFACTURING_VARIATION: Record<string, string> = {
  NONE: "Aucune variation",
  SECONDARY_PACKAGING: "Packaging secondaire (fabrication locale)",
  PRIMARY_PACKAGING: "Packaging primaire (fabrication locale)",
  FULL_PROCESS: "Full process (fabrication locale)",
};
/** Variations impliquant une fabrication locale → le fabricant devient obligatoire. */
export const LOCAL_MANUFACTURING_VARIATIONS = ["SECONDARY_PACKAGING", "PRIMARY_PACKAGING", "FULL_PROCESS"];

/**
 * Statut de fabrication d'un produit Regulatory (remplace l'ancien « type de produit »).
 * On démarre en Importation ; une **variation** peut faire évoluer vers un packaging local.
 */
export const MANUFACTURING_STATUS: Record<string, string> = {
  IMPORTATION: "Importation",
  SECONDARY_PACKAGING: "Secondary Packaging",
  PRIMARY_PACKAGING: "Primary Packaging",
  FULL_PROCESS: "Full Process",
};
/** Cibles possibles d'une variation (tout sauf le point de départ « Importation »). */
export const VARIATION_TARGETS = ["SECONDARY_PACKAGING", "PRIMARY_PACKAGING", "FULL_PROCESS"];

/** Cycle de vie d'une variation de fabrication (dépôt → décision). */
export const VARIATION_STATUS: Record<string, Display> = {
  EN_ATTENTE: { label: "En attente", tone: "warning" },
  OBTENUE: { label: "DE de variation obtenue", tone: "success" },
  ANNULE: { label: "Annulé", tone: "neutral" },
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

export const TASK_STATUS: Record<string, Display> = {
  REQUESTED: { label: "Demandée", tone: "warning" },
  TODO: { label: "À faire", tone: "neutral" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  DONE: { label: "Terminé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
  DECLINED: { label: "Refusée", tone: "danger" },
};

export const ADVANCE_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  APPROVED: { label: "Approuvée", tone: "info" },
  REJECTED: { label: "Refusée", tone: "danger" },
  PAID: { label: "Réglée", tone: "success" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

export const EXPENSE_ORDER_STATUS: Record<string, Display> = {
  PENDING: { label: "À régler", tone: "warning" },
  REVISION_REQUESTED: { label: "Révision budget demandée", tone: "purple" },
  PAID: { label: "Réglé", tone: "success" },
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

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  FINANCE_TRANSACTION: "Finances",
  EMPLOYEE: "Employé",
  PAYROLL: "Paie",
  LEAVE_REQUEST: "Congé",
  TASK: "Tâche",
  SALARY_ADVANCE: "Avance sur salaire",
  EXPENSE_ORDER: "Ordre de dépense",
  DRIVE_NODE: "Fichier / Dossier",
  ADMIN_REQUEST: "Demande administrative",
  DRIVER_MISSION: "Mission chauffeur",
  REGULATORY_PRODUCT: "Regulatory",
  REGULATORY_STEP: "Étape Regulatory",
  SPONSORING: "Sponsoring",
  BUDGET: "Budget",
  CONGRESS_INTERNATIONAL: "Prise en charge Internationale",
  CONGRESS_NATIONAL: "Prise en charge Nationale",
  SALE: "Vente",
  LOGISTICS: "Logistique PCH",
  DOCTOR: "Médecin",
  VISIT: "Visite",
  DELEGATE_PLAN: "Plan de tournée",
  BD_OPPORTUNITY: "Business Development",
  BD_PROJECT: "Projet BD",
  FEEDBACK: "Feedback",
  VALIDATION_REQUEST: "Validation",
  SUPPLIER: "Fournisseur",
  MEDICAL_INFO_DECLARATION: "Information médicale",
  DIRECTIVE: "Directive",
  SUPPORT_REQUEST: "Demande de support",
  DOSSIER: "Sujet",
  PROMO_MATERIAL: "Matériel promotionnel",
  HR_REQUEST: "Demande RH",
  EVENT: "Événement",
  MISSION_ASSIGNMENT: "Ordre de mission",
  PCH_TENDER: "Appel d'offres",
  PCH_ORDER: "Bon de commande (marché)",
  CONSULTING_CONTRACT: "Contrat de consulting",
  AD_PRO_OTHER: "Demande Ad & Pro — autre",
  AD_PRO_ITEM: "Poste de dépense",
  DOCUMENT_REQUEST: "Demande de pièce",
  PAYMENT_REQUEST: "Demande de paiement",
  MAIL_ENTRY: "Courrier",
  LEGAL_DOCUMENT: "Document légal",
  INVOICE: "Facture",
  PHARMACOVIGILANCE_CASE: "Cas de pharmacovigilance",
  STOCK_PCH_RELEVE: "Relevé du stock PCH",
};

/**
 * DEMANDE DE PAIEMENT — les états d'un dossier qui fait des allers-retours.
 *
 * « En attente » n'est pas « refusée » : la première reviendra, la seconde non. Les confondre,
 * c'est relancer les Finances pour rien, ou laisser mourir un dossier qui attendait une simple
 * trésorerie.
 */
export const PAYMENT_REQUEST_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  SUBMITTED: { label: "Chez les Finances", tone: "info" },
  UNDER_REVIEW: { label: "En cours d'instruction", tone: "info" },
  ON_HOLD: { label: "Mise en attente", tone: "warning" },
  CHANGES_REQUESTED: { label: "À revoir — chez le demandeur", tone: "warning" },
  APPROVED: { label: "Bon à payer", tone: "success" },
  REJECTED: { label: "Refusée", tone: "danger" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

/** Le verdict des Finances sur UNE pièce — refuser un dossier entier pour une facture floue obligerait à tout redéposer. */
export const PAYMENT_PIECE_STATUS: Record<string, Display> = {
  PENDING: { label: "À examiner", tone: "neutral" },
  ACCEPTED: { label: "Acceptée", tone: "success" },
  CHANGES_REQUESTED: { label: "À revoir", tone: "warning" },
  REJECTED: { label: "Refusée", tone: "danger" },
};

/** Les Finances ne cherchent pas « la pièce n° 3 » : elles cherchent LA FACTURE. */
export const PAYMENT_PIECE_KIND: Record<string, string> = {
  INVOICE: "Facture",
  PURCHASE_ORDER: "Bon de commande",
  QUOTE: "Devis",
  DELIVERY_NOTE: "Bon de livraison",
  CONTRACT: "Contrat",
  PROOF: "Justificatif",
  OTHER: "Autre pièce",
};

export const PAYMENT_PIECE_KIND_OPTIONS: { value: string; label: string }[] =
  Object.entries(PAYMENT_PIECE_KIND).map(([value, label]) => ({ value, label }));

/** À défaut de date convenue, l'urgence — sans quoi la demande finit au bas de la pile. */
export const PAYMENT_URGENCY: Record<string, string> = {
  URGENT: "Urgent",
  THIS_WEEK: "Cette semaine",
  THIS_MONTH: "Ce mois-ci",
  WHEN_POSSIBLE: "Dès que possible",
};

export const PAYMENT_URGENCY_OPTIONS: { value: string; label: string }[] =
  Object.entries(PAYMENT_URGENCY).map(([value, label]) => ({ value, label }));

/**
 * DEMANDE DE PIÈCE — les cinq états d'un fil court.
 *
 * « Refusé » n'est pas une fin : la demande repart, avec son motif. C'est le cas le plus
 * fréquent — ce n'était pas la bonne pièce — et il ne doit pas obliger à tout recommencer.
 */
/**
 * SEGMENTS THÉRAPEUTIQUES — le marché qu'un produit vise.
 *
 * Une liste fermée et non un champ libre : « Oncologie », « oncologie » et « Onco » ne se
 * comptent pas ensemble, et c'est précisément le comptage qu'on vient chercher. Un produit peut
 * en servir PLUSIEURS — un anti-émétique sert l'oncologie et la gastro-entérologie.
 */
export const THERAPEUTIC_SEGMENTS: string[] = [
  "Oncologie",
  "Hématologie",
  "Cardiologie",
  "Diabétologie / Endocrinologie",
  "Gynécologie / Obstétrique",
  "Urologie / Néphrologie",
  "Neurologie",
  "Psychiatrie",
  "Pneumologie",
  "Gastro-entérologie",
  "Rhumatologie",
  "Dermatologie",
  "Ophtalmologie",
  "ORL",
  "Infectiologie",
  "Immunologie",
  "Anesthésie / Réanimation",
  "Pédiatrie",
  "Antalgie",
  "Nutrition",
];

/**
 * La liste EFFECTIVE des segments thérapeutiques : celle que l'administrateur a définie si elle
 * existe, sinon la liste par défaut intégrée. Un seul endroit tranche — l'écran, le menu déroulant
 * et la validation à l'écriture lisent tous la même chose. Fonction PURE (partagée client/serveur).
 */
export function effectiveTherapeuticSegments(stored: readonly string[] | null | undefined): string[] {
  return stored && stored.length > 0 ? [...stored] : THERAPEUTIC_SEGMENTS;
}

/**
 * LES 58 WILAYAS D'ALGÉRIE — liste fermée, dans l'ordre du code administratif (1 → 58).
 *
 * Une liste fermée, et non un champ libre : « Alger », « ALGER », « alger » ou « Wilaya d'Alger »
 * doivent se compter et se filtrer ENSEMBLE — c'est tout l'intérêt d'une wilaya sur une fiche.
 * Le découpage compte 58 wilayas depuis la réforme de 2019 (les dix dernières, 49 → 58, ont été
 * érigées à partir d'anciennes circonscriptions du Sud). On stocke le seul nom : le code n'ajoute
 * rien à l'écran et compliquerait la reconnaissance à l'import.
 */
export const ALGERIA_WILAYAS: string[] = [
  "Adrar", "Chlef", "Laghouat", "Oum El Bouaghi", "Batna", "Béjaïa", "Biskra", "Béchar", "Blida",
  "Bouira", "Tamanrasset", "Tébessa", "Tlemcen", "Tiaret", "Tizi Ouzou", "Alger", "Djelfa", "Jijel",
  "Sétif", "Saïda", "Skikda", "Sidi Bel Abbès", "Annaba", "Guelma", "Constantine", "Médéa",
  "Mostaganem", "M'Sila", "Mascara", "Ouargla", "Oran", "El Bayadh", "Illizi", "Bordj Bou Arréridj",
  "Boumerdès", "El Tarf", "Tindouf", "Tissemsilt", "El Oued", "Khenchela", "Souk Ahras", "Tipaza",
  "Mila", "Aïn Defla", "Naâma", "Aïn Témouchent", "Ghardaïa", "Relizane", "Timimoun",
  "Bordj Badji Mokhtar", "Ouled Djellal", "Béni Abbès", "In Salah", "In Guezzam", "Touggourt",
  "Djanet", "El M'Ghair", "El Meniaa",
];

/** LEGAL — nature d'un engagement. Les bons de commande vivent ici avec les contrats. */
export const LEGAL_DOC_KIND: Record<string, string> = {
  CONTRACT: "Contrat",
  QUOTE: "Devis",
  PURCHASE_ORDER: "Bon de commande",
  INVOICE: "Facture",
  AGREEMENT: "Convention / accord-cadre",
  NDA: "Accord de confidentialité",
  INSURANCE: "Assurance",
  LICENSE: "Licence / autorisation",
  LEASE: "Bail",
  OTHER: "Autre",
};

/**
 * LE LIBELLÉ D'UNE NATURE LEGAL, POUR L'AFFICHER — toutes les natures, avenant compris.
 *
 * `LEGAL_DOC_KIND` a DEUX usages qui ne se confondent pas : la liste des natures qu'on CRÉE depuis
 * un formulaire générique, et le libellé qu'on AFFICHE. L'avenant n'est pas dans la première — il
 * naît de SON contrat (`amendsId`), avec son impact marché, et un avenant créé sans contrat serait
 * une pièce mal formée — donc il manquait à la seconde : la liste de Legal, la chaîne d'une pièce
 * et les pièces liées d'une fiche affichaient « AMENDMENT », le nom anglais de l'énumération, à une
 * personne qui lit « Avenant » partout ailleurs. Le libellé d'affichage couvre CHAQUE nature du
 * schéma (un test l'exige) ; la liste des natures créables ne bouge pas.
 */
// L'AVOIR suit la même règle que l'avenant : il naît de SA facture (§118.195), jamais d'un formulaire générique —
// donc il se LIT partout, et ne se CRÉE pas depuis la liste des natures.
const LIBELLE_NATURE_LEGALE: Record<string, string> = { ...LEGAL_DOC_KIND, AMENDMENT: "Avenant", CREDIT_NOTE: "Avoir" };

export function natureLegale(kind: string): string {
  return LIBELLE_NATURE_LEGALE[kind] ?? kind;
}

export const LEGAL_DOC_STATUS: Record<string, Display> = {
  ACTIVE: { label: "En vigueur", tone: "success" },
  EXPIRED: { label: "Échu", tone: "danger" },
  RENEWED: { label: "Renouvelé", tone: "info" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
};

/** L'urgence d'une échéance — même échelle que le module pur `legal/lifecycle`. */
export const LEGAL_EXPIRY_LEVEL: Record<string, Display> = {
  NONE: { label: "Sans échéance", tone: "neutral" },
  SCHEDULED: { label: "À terme", tone: "neutral" },
  SOON: { label: "Échéance < 3 mois", tone: "warning" },
  IMMINENT: { label: "Échéance < 1 mois", tone: "danger" },
  OVERDUE: { label: "Échéance dépassée", tone: "danger" },
};

/** COURRIERS — sens du pli. */
export const MAIL_DIRECTION: Record<string, Display> = {
  INCOMING: { label: "Entrant", tone: "info" },
  OUTGOING: { label: "Sortant", tone: "purple" },
};

/**
 * UNE FACTURE — la nature de document légal qui en est une, et OÙ EN EST SON RÈGLEMENT.
 *
 * ── POURQUOI L'ÉTAT SE DÉDUIT AU LIEU D'ÊTRE STOCKÉ ─────────────────────────────────────────
 *
 * Ce fichier portait un `INVOICE_STATUS` à quatre valeurs, écrit en base à côté d'une date de
 * paiement. Deux champs qui disent la même chose finissent par se contredire : une facture
 * « à régler » portant une date de règlement, et aucun écran pour lever le doute. L'état se
 * CALCULE désormais, à partir des seuls faits — la date de paiement, et l'ordre de dépense né de
 * la facture. Il ne peut plus mentir.
 *
 * ── ET POURQUOI TROIS ÉTATS, PAS DEUX ───────────────────────────────────────────────────────
 *
 * « Payée / à payer » ment sur le cas le plus fréquent : la facture PARTIE au circuit (centre de
 * paiement, puis Finances). Elle n'est pas payée — l'afficher comme telle ferait clore un dossier
 * ouvert — et elle n'est pas « à faire » : quelqu'un s'en occupe, et la relancer créerait un
 * second ordre pour la même somme.
 *
 * ── POURQUOI ICI, DANS LE VOCABULAIRE ───────────────────────────────────────────────────────
 *
 * Parce que la déduction n'est QUE la lecture de deux champs, et que tout le monde la lit :
 * l'écran Legal, la fiche marché, la recherche, la frise, Adam. Un module de domaine l'aurait
 * rendue inaccessible à la moitié d'entre eux, qui l'auraient alors recopiée — et deux copies
 * d'une règle d'affichage se répondent différemment le jour où l'une change.
 *
 * Le nom porte « invoice » EN ENTIER parce qu'un `settlementState` existe déjà, pour les ORDRES
 * DE DÉPENSE (`lib/finance/settlement.ts`, payé / reporté / à régler). Deux homonymes de sens
 * différents se prennent l'un pour l'autre à la première relecture pressée.
 */
export const INVOICE_KIND = "INVOICE";

export function isInvoice(kind: string): boolean {
  return kind === INVOICE_KIND;
}

export type InvoiceSettlementState = "NOT_INVOICE" | "UNPAID" | "IN_CIRCUIT" | "PAID";

/**
 * L'ordre des tests n'est pas anodin : une facture payée l'est, même si son ordre de dépense
 * existe encore. Lire le circuit d'abord afficherait « en règlement » sur une facture soldée, et
 * l'on relancerait la comptabilité pour un virement déjà parti.
 */
export function invoiceSettlementState(doc: {
  kind: string;
  paidDate: Date | string | null;
  expenseOrderId?: string | null;
}): InvoiceSettlementState {
  if (!isInvoice(doc.kind)) return "NOT_INVOICE";
  if (doc.paidDate) return "PAID";
  if (doc.expenseOrderId) return "IN_CIRCUIT";
  return "UNPAID";
}

/** Comment l'état se dit à l'écran. Rien pour ce qui n'est pas une facture : c'est voulu. */
export const INVOICE_SETTLEMENT: Record<string, Display> = {
  UNPAID: { label: "À régler", tone: "warning" },
  IN_CIRCUIT: { label: "En règlement", tone: "info" },
  PAID: { label: "Réglée", tone: "success" },
};

export const PIECE_REQUEST_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente de dépôt", tone: "warning" },
  SUBMITTED: { label: "Déposé — à confirmer", tone: "info" },
  ACCEPTED: { label: "Pièce reçue", tone: "success" },
  DECLINED: { label: "Refusé — à redéposer", tone: "danger" },
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

/** DEMANDE « AUTRE » — circuit court : il n'y a pas de parcours propre, il y a un décideur. */
export const AD_PRO_OTHER_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  AWAITING_DECISION: { label: "En attente de décision", tone: "warning" },
  APPROVED: { label: "Validée", tone: "info" },
  REFUSED: { label: "Refusée", tone: "danger" },
  DONE: { label: "Terminée", tone: "success" },
  CANCELLED: { label: "Annulée", tone: "danger" },
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

export const DOC_REQUEST_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  FULFILLED: { label: "Déposée", tone: "success" },
};

export const DIRECTIVE_STATUS: Record<string, Display> = {
  OPEN: { label: "À traiter", tone: "warning" },
  ACKNOWLEDGED: { label: "Pris en compte", tone: "info" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  DONE: { label: "Traité", tone: "success" },
  ARCHIVED: { label: "Archivé", tone: "neutral" },
};

export const SUPPORT_CATEGORY: Record<string, Display> = {
  QUESTION: { label: "Question", tone: "info" },
  SUPPORT_MATERIAL: { label: "Support de visite", tone: "purple" },
  BROCHURE: { label: "Brochure", tone: "purple" },
  DOCUMENT: { label: "Document / PDF", tone: "info" },
  OTHER: { label: "Autre", tone: "neutral" },
};

export const SUPPORT_STATUS: Record<string, Display> = {
  OPEN: { label: "À traiter", tone: "warning" },
  IN_PROGRESS: { label: "Pris en charge", tone: "info" },
  ANSWERED: { label: "Répondu", tone: "success" },
  CLOSED: { label: "Clôturé", tone: "neutral" },
};

export const DOSSIER_STATUS: Record<string, Display> = {
  OPEN: { label: "Ouvert", tone: "warning" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  ON_HOLD: { label: "En attente", tone: "neutral" },
  DONE: { label: "Abouti", tone: "success" },
  ARCHIVED: { label: "Archivé", tone: "neutral" },
};

export const FEEDBACK_STATUS: Record<string, Display> = {
  NEW: { label: "À traiter", tone: "warning" },
  SEEN: { label: "Vu", tone: "info" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  DONE: { label: "Traité", tone: "success" },
};

export const VALIDATION_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  APPROVED: { label: "Validé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  // « À corriger », comme une demande Ad & Pro renvoyée (§118.186) : depuis l'audit 360° (R08), une
  // demande renvoyée n'est plus close — son demandeur la corrige et la resoumet.
  CHANGES_REQUESTED: { label: "À corriger", tone: "warning" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
};

export const VALIDATION_STEP_STATE: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  APPROVED: { label: "Validé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  CHANGES_REQUESTED: { label: "Correction demandée", tone: "warning" },
  SKIPPED: { label: "Ignoré", tone: "neutral" },
};

export const VALIDATION_MODE: Record<string, string> = {
  SEQUENTIAL: "Séquentiel",
  PARALLEL: "Parallèle",
};

export const NOTIFICATION_TYPE: Record<string, Display> = {
  DEADLINE_NEAR: { label: "Échéance proche", tone: "warning" },
  LATE: { label: "Retard", tone: "danger" },
  ASSIGNMENT: { label: "Assignation", tone: "info" },
  DOCUMENT_UPLOADED: { label: "Document", tone: "info" },
  VALIDATION_REQUIRED: { label: "Validation requise", tone: "warning" },
  BUDGET_EXCEEDED: { label: "Budget dépassé", tone: "danger" },
  PCH_DELAY: { label: "Retard PCH", tone: "danger" },
  REGULATORY_BLOCKED: { label: "Dossier bloqué", tone: "danger" },
  SPONSORING_VALIDATION: { label: "Sponsoring", tone: "warning" },
  BD_NEXT_ACTION: { label: "Action BD", tone: "info" },
  MEDICAL_TOUR: { label: "Tournée médicale", tone: "info" },
  GENERIC: { label: "Notification", tone: "neutral" },
};

export const AUDIT_ACTION: Record<string, Display> = {
  CREATE: { label: "Création", tone: "success" },
  UPDATE: { label: "Modification", tone: "info" },
  DELETE: { label: "Suppression", tone: "danger" },
  LOGIN: { label: "Connexion", tone: "neutral" },
  LOGOUT: { label: "Déconnexion", tone: "neutral" },
  EXPORT: { label: "Export", tone: "info" },
  IMPORT: { label: "Import", tone: "info" },
  UPLOAD: { label: "Upload", tone: "info" },
  VALIDATE: { label: "Validation", tone: "success" },
  REFUSE: { label: "Refus", tone: "danger" },
};

// ─────────────── Messagerie interne ───────────────

export const CONVERSATION_TYPE: Record<string, Display> = {
  DIRECT: { label: "Message direct", tone: "info" },
  GROUP: { label: "Groupe", tone: "purple" },
  CHANNEL: { label: "Canal", tone: "neutral" },
};

export const CONV_MEMBER_ROLE: Record<string, string> = {
  OWNER: "Propriétaire",
  ADMIN: "Administrateur",
  MEMBER: "Membre",
};

export const CONV_NOTIFY_LEVEL: Record<string, string> = {
  ALL: "Tous les messages",
  MENTIONS: "Mentions uniquement",
  NONE: "Silencieux",
};

/** Un onglet d'une entrée fusionnée (sous-module + route). */
export interface NavTab {
  module: Module;
  label: string;
  href: string;
  /**
   * L'ANNUAIRE que cet onglet montre (§118.147). Présent = l'onglet s'affiche selon la règle de
   * l'accès par annuaire — le module de son référentiel OU l'annuaire coché dans la console —,
   * et plus selon le seul `module`. Absent = la règle ordinaire du module.
   */
  annuaire?: AnnuaireAccordable;
  /**
   * Nouveauté livrée derrière un drapeau de version (`src/lib/features.ts`) : l'onglet
   * n'apparaît qu'aux comptes qui la voient (stade TEST → testeurs, stade PROD → tout le
   * monde). Absent = onglet visible dès que le module est autorisé.
   */
  feature?: string;
  /**
   * Une RÈGLE nommée qui décide de l'affichage à la place du seul `module` — la même que la page et
   * les actions lisent (`nav-tabs.ts` la traduit). `"specialites"` : `peutGererSpecialites`, qui ouvre
   * le référentiel aux deux directeurs des opérations même sans la Promotion médicale en écriture.
   * `"marche-cockpit"` / `"argent-cockpit"` : le module PUIS la règle du marché ou de l'argent du Marketing cockpit
   * (`marketing-cockpit/acces.ts`).
   */
  regle?: "specialites" | "marche-cockpit" | "argent-cockpit";
}

/** Navigation metadata: maps a sidebar entry to a module + route + icon name. */
export interface NavItem {
  module: Module;
  label: string;
  href: string;
  icon: string; // lucide-react icon name
  group: "Pilotage" | "Pôles" | "Transverse" | "Système";
  /**
   * Pôle d'entreprise auquel l'entrée appartient (groupe « Pôles » uniquement). C'est ce qui
   * remplace les treize entrées à plat : l'utilisateur voit son entreprise, pas les modules.
   */
  pole?: "REGULATORY" | "ADMINISTRATION" | "MARKETING" | "OPERATIONS_SALES" | "BUSINESS_DEV";
  /**
   * Garde SUPPLÉMENTAIRE au droit de module, résolue côté serveur dans le layout. Sert aux
   * écrans dont l'ouverture dépend d'un réglage et pas seulement d'un rôle (l'analyse CTD est
   * débloquée en Administration, rôle par rôle). `adamMissions` : le Centre de missions n'est
   * envoyé qu'au Super Admin (`peutPiloterMissionsAdam`, §118.136) — le module WORKSPACE est à
   * tout le monde, la règle n'est pas un module.
   */
  gate?: "regEnrollment" | "pipeline" | "payroll" | "myTeam" | "adamMissions" | "adam" | "corbeilleOps" | "pharmacovigilance";
  /**
   * Entrée fusionnée : plusieurs sous-modules présentés en onglets sur la page.
   * L'entrée est visible si l'utilisateur a accès à **au moins un** onglet, et son
   * lien est résolu (dans le layout) vers le premier onglet autorisé. Aucune
   * fonctionnalité n'est retirée : chaque onglet reste sa propre route, gardée par
   * son propre module.
   */
  tabs?: NavTab[];
  /**
   * SOUS-MODULES — des modules à part entière, rangés SOUS un autre dans le menu.
   *
   * Différent de `tabs` : un onglet est une section d'un même écran, un enfant est un module
   * autonome (sa route, sa garde, son écran) rangé sous son parent. Il se déplie par une flèche,
   * sur ordinateur comme sur mobile.
   *
   * La PAIE s'en sert : elle vit sous « Ressources humaines », derrière la flèche, parce qu'elle
   * n'a pas la même audience que le reste du module (voir l'entrée RH plus bas).
   */
  children?: NavItem[];
  /**
   * UN GROUPE de sous-modules (Ressources humaines, Direction 06/10) : l'entrée s'affiche dès qu'UN de ses enfants est
   * ouvert, même sans le module du parent — elle mène alors au premier enfant ouvert.
   */
  groupe?: boolean;
  /** Préfixes de chemin additionnels qui activent l'entrée (pour les entrées fusionnées). */
  match?: string[];
}

// (L'« Espace comptable » a été fusionné dans la page Finances : plus d'onglets.)
export const CONGRESS_TABS: NavTab[] = [
  { module: "CONGRESS_INTERNATIONAL", label: "Internationaux", href: "/congress-international" },
  { module: "CONGRESS_NATIONAL", label: "Nationaux", href: "/congress-national" },
];
/**
 * L'ESPACE PERSONNEL — UN SEUL ENDROIT.
 *
 * Il y en avait trois : « Mon travail » (ce qu'on doit signer et traiter), « Mon espace » (ses
 * tâches, ses congés) et « Mon dossier RH » (ses documents, ses demandes) — trois écrans pour
 * une seule question, « qu'est-ce qui me concerne ? ». On les ouvrait l'un après l'autre pour
 * en faire le tour, et l'on manquait celui qu'on n'avait pas pensé à ouvrir.
 *
 * « Mon travail » a fondu DANS « Mon espace » : ce qui attend une signature s'y lit en tête, les
 * tâches en dessous — puis les ordres de mission et les pièces demandées y sont devenus des
 * SECTIONS à leur tour. « Mon dossier RH » reste le seul onglet frère : c'est le dossier de la
 * personne (documents, demandes, congés), pas son travail. Le « Dashboard » a disparu.
 */
export const WORKSPACE_TABS: NavTab[] = [
  // « Aujourd'hui » : l'accueil qui répond à une seule question — que dois-je faire maintenant ?
  { module: "WORKSPACE", label: "Aujourd'hui", href: "/aujourdhui", feature: "home_today" },
  { module: "WORKSPACE", label: "Mon espace", href: "/mon-espace" },
  // TOUTES LES TÂCHES EN UN SEUL ENDROIT (Direction, 07/10) — à accepter, à faire, demandées, partagées, terminées.
  // Le compteur de l'onglet est posé par `ongletsEspace` (`queries/mes-taches.ts`).
  { module: "WORKSPACE", label: "Tâches", href: "/mon-espace/taches" },
  // MES MISSIONS (Direction, 10/2026) — les missions Ad & Pro reliées au profil : invitations, ordre de mission
  // (N+1 → RH), et les étapes que la personne ajoute. `/missions` y renvoie.
  { module: "WORKSPACE", label: "Mes missions", href: "/mon-espace/missions" },
  { module: "WORKSPACE", label: "Mon dossier RH", href: "/mon-dossier" },
  // MON BILAN (KPI sans code, Direction 08/10) : ses KPI en continu, sa revue signée, ses déclarations.
  { module: "KPI", label: "Mon bilan", href: "/mon-espace/bilan" },
  // PLUS D'ONGLET « ANNUAIRE » (Direction, 06/10 : « enlève Annuaire de Mon espace ») : les carnets vivent dans le
  // module Annuaires. La page `/mon-espace/annuaire` reste servie — liens et notifications y pointent encore.
  // Les pièces demandées ne sont PLUS un onglet : elles s'affichent en SECTION dans « Mon espace »
  // (la page /pieces survit — liens et notifications y pointent encore).
  // PLUS D'ONGLET « DIRECTIVES » (Direction, 07/10) : elles restent dans « Aujourd'hui », le centre d'actions, la
  // recherche et les notifications ; /directives reste servie.
];
/**
 * L'AGENDA — le calendrier ET les réunions, au même endroit.
 *
 * C'étaient deux entrées de menu, dans deux groupes différents, pour une seule journée : le
 * « Calendrier » projetait DÉJÀ les réunions planifiées (`getScheduledMeetingsAsEvents`), et
 * « Réunions & appels » listait les mêmes objets sous un autre angle. On planifiait d'un côté,
 * on retrouvait de l'autre, et l'on cherchait toujours dans celui qu'on n'avait pas ouvert.
 *
 * Une entrée, deux vues : le MOIS (où l'on voit sa journée) et la LISTE des réunions (où l'on
 * ouvre un compte rendu). Elles n'ont pas le même module — l'une tient à l'espace de travail,
 * l'autre à la messagerie — et c'est justement ce que les onglets savent faire : chacun
 * n'apparaît qu'à qui y a droit.
 */
export const AGENDA_TABS: NavTab[] = [
  { module: "WORKSPACE", label: "Calendrier", href: "/calendar" },
  { module: "MESSAGING", label: "Réunions & appels", href: "/meetings" },
];

// BUDGETS — trois écrans au lieu d'un seul écran fourre-tout : on REGARDE (vue d'ensemble
// graphique), on TRAVAILLE (dépenses à imputer), on RÈGLE (enveloppe, catégories, total).

export const BUDGET_TABS: NavTab[] = [
  { module: "BUDGETS", label: "Vue d'ensemble", href: "/budgets" },
  { module: "BUDGETS", label: "Dépenses", href: "/budgets/depenses" },
  { module: "BUDGETS", label: "Départements", href: "/budgets/departements" },
  // LE BUDGET PAR GAMME — une Business Unit EST un sous-département, mais on ne vient pas la
  // chercher dans une liste où elle voisine avec les Finances et les Ressources humaines : la
  // question « combien l'oncologie a-t-elle dépensé ? » se pose sur les gammes, entre elles.
  { module: "BUDGETS", label: "Business Units", href: "/budgets/business-units" },
  { module: "BUDGETS", label: "Réglages", href: "/budgets/reglages" },
];

// BUDGET MARKETING (Direction, 08/10) — les écrans de Budgets, bornés aux enveloppes de la Direction Marketing, plus
// la liste des demandes Ad & Pro qui consomment l'enveloppe. Mêmes lignes en base : Budgets les lit aussi.
export const BUDGET_MARKETING_TABS: NavTab[] = [
  { module: "BUDGET_MARKETING", label: "Vue d'ensemble", href: "/budget-marketing" },
  { module: "BUDGET_MARKETING", label: "Dépenses", href: "/budget-marketing/depenses" },
  { module: "BUDGET_MARKETING", label: "Demandes Ad & Pro", href: "/budget-marketing/ad-pro" },
  { module: "BUDGET_MARKETING", label: "Réglages", href: "/budget-marketing/reglages" },
];

// BUDGET REGULATORY et BUDGET OPERATIONS & SALES (Direction, 08/10) — la même mécanique que Budget Marketing : les écrans
// de Budgets bornés aux enveloppes du pôle, plus l'écran propre au pôle (les BV par dossier ; la masse salariale).
export const BUDGET_REGULATORY_TABS: NavTab[] = [
  { module: "BUDGET_REGULATORY", label: "Vue d'ensemble", href: "/budget-regulatory" },
  { module: "BUDGET_REGULATORY", label: "BV par dossier", href: "/budget-regulatory/bv" },
  { module: "BUDGET_REGULATORY", label: "Dépenses", href: "/budget-regulatory/depenses" },
  { module: "BUDGET_REGULATORY", label: "Réglages", href: "/budget-regulatory/reglages" },
];
export const BUDGET_OPERATIONS_TABS: NavTab[] = [
  { module: "BUDGET_OPERATIONS", label: "Vue d'ensemble", href: "/budget-operations" },
  { module: "BUDGET_OPERATIONS", label: "Masse salariale", href: "/budget-operations/masse-salariale" },
  { module: "BUDGET_OPERATIONS", label: "Dépenses", href: "/budget-operations/depenses" },
  { module: "BUDGET_OPERATIONS", label: "Réglages", href: "/budget-operations/reglages" },
];

// VENTES PCH (Direction, 08/10) — les fichiers de la PCH lus par BU. Il remplace « Ventes » (saisie manuelle, module
// `SALES` retiré du service) : son historique reste lisible, en lecture seule, dans le dernier onglet.
export const VENTES_PCH_TABS: NavTab[] = [
  { module: "PCH_VENTES", label: "Synthèse", href: "/sales" },
  { module: "PCH_VENTES", label: "Contrats", href: "/sales/contrats" },
  { module: "PCH_VENTES", label: "Territoires", href: "/sales/territoires" },
  { module: "PCH_VENTES", label: "Non servi", href: "/sales/non-servi" },
  { module: "PCH_VENTES", label: "Importer", href: "/sales/importer" },
  { module: "PCH_VENTES", label: "Historique", href: "/sales/historique" },
];
// LES SOUS-MODULES RH (Direction, 06/10) — indépendants (chacun son droit, réglable dans la console) mais reliés (un même
// groupe « Ressources humaines » dans le menu, et chaque page renvoie aux autres).
// « Employés » : l'équipe, les consultants suivis par les RH (§118.150), la structure (départements).
export const EMPLOYES_TABS: NavTab[] = [
  { module: "EMPLOYEES", label: "Équipe", href: "/rh/equipe" },
  // Les contrats des consultants suivis par les RH — les mêmes contrats qu'Ad & Pro › Consulting, au pôle RH : c'est ici
  // qu'arrive un contrat transféré depuis Ad & Pro.
  { module: "EMPLOYEES", label: "Consultants", href: "/rh/consultants" },
  { module: "EMPLOYEES", label: "Départements", href: "/rh/departements" },
];
// « Demandes RH » : les demandes des salariés (attestations, ordres de mission, notes de frais, entrevues) et les congés.
export const DEMANDES_RH_TABS: NavTab[] = [
  { module: "HR_REQUESTS", label: "Demandes", href: "/rh/demandes" },
  { module: "HR_REQUESTS", label: "Congés et absences", href: "/rh/conges" },
];
/** Compatibilité : les écrans RH d'avant le découpage. */
export const HR_TABS: NavTab[] = [...EMPLOYES_TABS, ...DEMANDES_RH_TABS];// « Ad & Pro » : sponsoring + congrès (international/national) + événements +
// matériel promotionnel, sous un seul module. Le matériel promotionnel a été
// déplacé ici depuis « Promotion médicale » (sa fonctionnalité est inchangée).
/**
 * VENTES · LOGISTIQUE · PCH — TROIS MODULES SÉPARÉS, plus une entrée à onglets.
 *
 * Les regrouper supposait qu'on passe de l'un à l'autre ; en réalité on ouvre les Ventes pour
 * le chiffre d'affaires, la Logistique pour une livraison et PCH pour un appel d'offres — trois
 * métiers, trois moments. Chacun a désormais sa propre entrée de menu (Ventes sous Sales &
 * Marketing, Marchés PCH sous Business Development, Commandes & logistique sous Supply Chain).
 */

export const EVENTS_TABS: NavTab[] = [
  // UNE SEULE DEMANDE : la vue unifiée ouvre le pôle. Les écrans par nature restent derrière —
  // ils portent les champs propres (billets, visas, devis d'agence) et leurs circuits.
  { module: "SPONSORING", label: "Toutes les demandes", href: "/ad-pro" },
  { module: "SPONSORING", label: "Sponsoring", href: "/sponsoring" },
  { module: "CONGRESS_INTERNATIONAL", label: "Prises en charge Internationales", href: "/congress-international" },
  { module: "CONGRESS_NATIONAL", label: "Prises en charge Nationales", href: "/congress-national" },
  { module: "EVENTS", label: "Événements", href: "/events" },
  { module: "PROMO_MATERIAL", label: "Matériel promotionnel", href: "/promo-material" },
  // LE STOCK ET LE CATALOGUE NE SONT PLUS DES ONGLETS D'AD & PRO (§118.173) — décision de la
  // Direction (01/10) : « un sous-module à part de Sales & Marketing, totalement à part ». Ils ont
  // leur propre entrée de menu (`STOCK_PROMO_TABS`), et restent reliés aux achats par leurs liens :
  // une réception de facture entre au magasin, un poste Ad & Pro y réserve son matériel.
  { module: "CONSULTING", label: "Consulting", href: "/consulting" },
  { module: "AD_PRO_OTHER", label: "Autres demandes", href: "/ad-pro/autres" },
];
/**
 * LE STOCK PROMOTIONNEL — un sous-module À PART du pôle Sales & Marketing (§118.173).
 *
 * Deux écrans, deux questions : le STOCK (« qu'avons-nous, où, et qu'est-ce qui est en route ? »,
 * module `PROMO_STOCK` : le directeur des opérations tient le stock de ses équipes sans instruire
 * d'achat) et le CATALOGUE (les supports qu'on peut commander, triés en trois familles, module
 * `PROMO_CATALOG` : au Super Admin par défaut, ouvert par lui à qui il veut). L'entrée de menu
 * s'ouvre sur le premier des deux que la personne a le droit de voir. Les adresses vivent au socle
 * (`chemins/stock-promo.ts`) : le menu, les actions, les rappels et les écrans les lisent.
 */
export const STOCK_PROMO_TABS: NavTab[] = [
  { module: "PROMO_STOCK", label: "Stock", href: CHEMIN_STOCK_PROMO },
  { module: "PROMO_CATALOG", label: "Catalogue", href: CHEMIN_CATALOGUE_PROMO },
];
/**
 * MARKETING COCKPIT — le tableau de la Direction Marketing (Direction, 07/10 — maquette validée). UNE page,
 * `/marketing-cockpit`, et ses vues par `?vue=` : le produit choisi (`?produit=`) suit d'une vue à l'autre, ce
 * qu'une route par onglet perdrait. La page rend elle-même la barre (l'onglet actif est un paramètre, pas un
 * chemin) : l'entrée de menu n'a donc pas de `tabs`. « Spécialités » est parti dans les Annuaires (07/10).
 * « Marché » s'affiche à qui a DÉJÀ le marché (Business Development) ; « Investissements » à qui lit l'argent.
 */
export const MARKETING_COCKPIT_TABS: NavTab[] = [
  { module: "MARKETING_COCKPIT", label: "Vue d'ensemble", href: "/marketing-cockpit" },
  { module: "MARKETING_COCKPIT", label: "Leaders d'opinion", href: "/marketing-cockpit?vue=leaders" },
  { module: "MARKETING_COCKPIT", label: "Messages", href: "/marketing-cockpit?vue=messages" },
  { module: "MARKETING_COCKPIT", label: "Marché", href: "/marketing-cockpit?vue=marche", regle: "marche-cockpit" },
  { module: "MARKETING_COCKPIT", label: "Investissements", href: "/marketing-cockpit?vue=investissements", regle: "argent-cockpit" },
];
/**
 * FORCE DE VENTE — l'outil du superviseur et de la Direction (Direction, 07/10 — maquette validée). Trois vues :
 * « Pilotage » (l'ouverture), « Territoires » (secteurs, panel par lettre, charge, cibles hors panel), « Produits »
 * (P1/P2/P3 par délégué). Business units, secteurs et paramètres sont un module à part : « Business Units » (08/10).
 */
export const SALES_PLANNING_TABS: NavTab[] = [
  { module: "SALES_PLANNING", label: "Pilotage", href: "/planning" },
  { module: "SALES_PLANNING", label: "Territoires", href: "/planning/territoires" },
  { module: "SALES_PLANNING", label: "Produits", href: "/planning/produits" },
];
/**
 * BUSINESS UNITS — le montage de la force de vente (Direction, 08/10 : « tu crées dans le menu un module "Business Units"
 * et tu y mets BU et secteurs et paramètres »). Il vivait dans le « ⋯ Réglages » de la Force de vente.
 */
export const BUSINESS_UNITS_TABS: NavTab[] = [
  { module: "BUSINESS_UNITS", label: "Business units", href: "/business-units" },
  { module: "BUSINESS_UNITS", label: "Secteurs", href: "/business-units/secteurs" },
  { module: "BUSINESS_UNITS", label: "Paramètres", href: "/business-units/parametres" },
];
// Module « Drive » (Drive personnel). L'onglet « Documents » a été retiré (tout est consolidé
// dans le Drive + les catégories partagées ; on y glisse des dossiers à la souris).
export const DOCS_TABS: NavTab[] = [
  { module: "DRIVE", label: "Drive", href: "/drive" },
];
// Promotion médicale (annuaire, segmentation) et Rapports terrain sont désormais DEUX modules
// distincts (accès configurables séparément dans Administration). Les onglets partagés sont retirés.
// Adventum Brain + Process Intelligence, dans un seul cockpit Super Admin.
export const BRAIN_TABS: NavTab[] = [
  { module: "ADVENTUM_BRAIN", label: "Adventum Brain", href: "/adventum-brain" },
  { module: "PROCESS_INTELLIGENCE", label: "Process Intelligence", href: "/process-intelligence" },
];
// Administration : console + Contrôle de l'IA + Score d'adoption.
export const ADMIN_TABS: NavTab[] = [
  { module: "ADMIN", label: "Administration", href: "/admin" },
  { module: "ADMIN", label: "Bases de données", href: "/admin/bases" },
  // L'arbre entité → gammes → produits : de lui découle ce que chacun voit de la plateforme.
  { module: "ADMIN", label: "Gammes & produits", href: "/admin/gammes" },
  { module: "ADMIN", label: "Contrôle de l'IA", href: "/admin/ai" },
  // Le catalogue des KPI et les modèles par rôle (KPI sans code) — Super Admin seul.
  { module: "ADMIN", label: "KPI & modèles", href: "/admin/kpi" },
  { module: "ADMIN", label: "Coût IA & audit Regulatory", href: "/admin/regulatory-ia" },
  { module: "ADMIN", label: "Score d'adoption", href: "/admin/adoption" },
  { module: "ADMIN", label: "Diagnostic", href: "/admin/diagnostic" },
  // La couche de connaissance tourne en fond, donc invisible par construction : sans cet écran,
  // une file qui s'engorge ou une dérive vers les modèles chers se découvre sur une facture.
  { module: "ADMIN", label: "Couche de connaissance", href: "/admin/connaissance" },
  { module: "ADMIN", label: "Messagerie & notifications", href: "/admin/messagerie" },
  // La LIAISON au site public (§118.160) : la clé, la vérification, le rapprochement à la demande,
  // la mise en service — Super Admin seul. Les contenus se publient, eux, depuis le module « Site web ».
  { module: "ADMIN", label: "Site web (connexion)", href: "/admin/site-web" },
  { module: "ADMIN", label: "Test Center", href: "/admin/test-center" },
];

/**
 * Libellé lisible et **stable** par module, indépendant du menu (qui fusionne
 * désormais plusieurs modules sous une seule entrée). Utilisé par l'administration
 * (matrice d'accès) pour nommer chaque module, même ceux qui n'ont plus d'entrée
 * de menu dédiée. Typé `Record<Module, string>` → exhaustivité garantie.
 */
export const MODULE_LABELS: Record<Module, string> = {
  FEEDBACK: "Feedback",
  GENERAL_MEANS: "Moyens généraux",
  LEGAL: "Legal",
  MAIL_REGISTER: "Courriers",
  RECRUITMENT: "Recrutement",
  MY_TEAM: "Mon Équipe",
  DIRECTORIES: "Annuaires",
  WORKSPACE: "Espace de travail",
  MESSAGING: "Messagerie",
  REGULATORY: "Regulatory",
  REGULATORY_PIPELINE: "Pipeline réglementaire",
  SPONSORING: "Sponsoring",
  BUDGETS: "Budgets",
  BUDGET_MARKETING: "Budget Marketing",
  BUDGET_REGULATORY: "Budget Regulatory",
  BUDGET_OPERATIONS: "Budget Operations & Sales",
  FINANCES: "Finances",
  RH: "Ressources humaines",
  CONGRESS_INTERNATIONAL: "Prises en charge Internationales",
  CONGRESS_NATIONAL: "Prises en charge Nationales",
  EVENTS: "Événements",
  SALES: "Ventes",
  LOGISTICS: "Logistique",
  // « Annuaire » était le nom de l'écran d'ORIGINE de ce module ; le menu dit « Promotion
  // médicale » depuis le chantier force de vente, et la console d'accès continuait à le
  // présenter sous son ancien nom. On cherchait « Promotion médicale » dans la liste des
  // modules et on ne le trouvait pas — un droit qu'on n'arrive pas à nommer est un droit qu'on
  // ne donne pas. Le libellé du module suit celui du menu.
  MEDICAL: "Promotion médicale",
  FIELD_REPORTS: "Rapports terrain",
  SALES_PLANNING: "Prévisions & Force de vente",
  BUSINESS_UNITS: "Business Units",
  // LES TROIS ÉCRANS DU PÔLE SE NOMMENT ICI COMME DANS LE MENU, et se règlent séparément.
  // « Business Development » couvrait DEUX entrées de menu (Market Intelligence et
  // l'Explorateur produits) sous un seul droit : on ne pouvait ni ouvrir l'un sans l'autre,
  // ni retrouver « Explorateur produits » dans la console — le nom n'y existait pas.
  BUSINESS_DEVELOPMENT: "Market Intelligence",
  PRODUCT_EXPLORER: "Explorateur produits",
  PCH: "Marchés PCH",
  STOCKS: "Stocks PCH",
  MEDICAL_INFO: "Information médicale",
  PROMO_MATERIAL: "Matériel promotionnel",
  PROMO_STOCK: "Stock promotionnel",
  PROMO_CATALOG: "Catalogue promotionnel",
  CONSULTING: "Consulting",
  AD_PRO_OTHER: "Ad & Pro — autres demandes",
  VALIDATIONS: "Demandes de validations",
  VALIDATION_CENTRE: "Centre de validations",
  AD_PRO_CENTRE: "Centre de validation Ad & Pro",
  DIRECTIVES: "Directives",
  SUPPORT: "Demandes de support",
  // « SUJETS » — Pilotage (anciennement « Projets », renommé sur décision de la Direction,
  // 30/09/2026) : un sujet délégué et suivi (recherche, analyse, demande). « Projets » ne nomme
  // plus que le registre de Business Development (§118.163).
  DOSSIERS: "Sujets",
  DOCUMENTS: "Documents",
  DRIVE: "Drive",
  ADMIN_REQUESTS: "Bureau du secrétariat",
  PAYMENT_CENTRE: "Centre de paiement",
  CHIEF_OF_STAFF: "My Chief of Staff",
  NOTIFICATIONS: "Notifications",
  PROCESS_INTELLIGENCE: "Process Intelligence",
  ADVENTUM_BRAIN: "Adventum Brain",
  ADMIN: "Administration",
  SITE_WEB: "Site web",
  // « PROJETS » (BD) — le registre par lequel on classe les dossiers réglementaires, devenu un
  // module réglé depuis la console comme les autres (§118.163). Le libellé suit le menu ; il ne
  // se confond plus avec Pilotage, renommé « Sujets » : deux cases « Projets » dans la console
  // feraient ouvrir l'un en croyant ouvrir l'autre.
  BD_PROJECTS: "Projets",
  // « BONS DE COMMANDE » — la file des bons de commande à signer, devenue un module à part des
  // Finances (§118.176). Le libellé suit le menu : c'est sous ce nom qu'on le cherche dans la
  // console pour l'ouvrir à quelqu'un.
  PURCHASE_ORDERS: "Bons de commande",
  MARKETING_COCKPIT: "Marketing cockpit",
  SEGMENTATION: "Segmentation Studio",
  SEGMENTATION_POTENTIEL: "Segmentation — potentiel forcé à la main",
  CONSUMPTION: "Consumption Intelligence",
  PRODUCTS: "Produits",
  EMPLOYEES: "Employés",
  HR_REQUESTS: "Demandes RH",
  TRAINING: "Formations",
  PHARMACOVIGILANCE: "Pharmacovigilance",
  PCH_VENTES: "Ventes PCH",
  KPI: "KPI & bilans",
  COCKPIT_OPERATIONS: "Cockpit Opérations",
  BUDGET_CAMPAIGN: "Campagne budgétaire",
  ART_DIRECTION: "Direction artistique",
};

/**
 * Les ACTIONS, en français. Un seul endroit : l'écran des accès, la fiche d'un employé et le
 * journal d'audit doivent nommer « Valider » de la même façon, sinon deux écrans décrivent le
 * même droit avec deux mots et personne ne sait s'il s'agit du même.
 */
export const ACTION_LABELS: Record<Action, string> = {
  VIEW: "Voir",
  CREATE: "Créer",
  UPDATE: "Modifier",
  DELETE: "Supprimer",
  VALIDATE: "Valider",
  EXPORT: "Exporter",
  UPLOAD: "Téléverser",
};

// Navigation simplifiée : modules fusionnés en onglets (`tabs`) pour réduire le
// nombre d'entrées. Messagerie & Notifications ne sont PLUS dans le menu — elles
// restent accessibles via leurs icônes dans la barre du haut (les routes /messages
// et /notifications et leurs modules RBAC sont inchangés).
/**
 * PROMOTION MÉDICALE — « Ma journée » (le terrain) et l'annuaire (le référentiel).
 *
 * Le premier onglet est celui qu'on ouvre chaque matin ; le second celui qu'on consulte. Mettre
 * l'annuaire en tête obligeait un délégué à traverser un référentiel pour noter une visite.
 */
export const MEDICAL_TABS: NavTab[] = [
  { module: "MEDICAL", label: "Ma journée", href: "/medical/ma-journee" },
  // LE PLAN DE TOURNÉE — là où le KAM prépare son mois et où son N+1 le tranche. Il vient
  // AVANT l'annuaire : un engagement validé passe devant un référentiel qu'on consulte.
  { module: "MEDICAL", label: "Plan de tournée", href: "/medical/plan-de-tournee" },
  // LE COACHING — la fiche « tournée en double » (§118.157), juste après le plan de tournée : on
  // l'écrit au retour d'une tournée. Sa grille est administrée par le directeur des opérations,
  // qui n'a que la LECTURE du module — l'onglet s'affiche donc sur le droit de voir, et ce que
  // chacun y FAIT vient de la règle du coaching (`lib/coaching/acces.ts`).
  { module: "MEDICAL", label: "Coaching", href: "/medical/coaching" },
  // LES RAPPORTS TERRAIN (Direction, 07/10) — plus une entrée de menu à part : le KAM rapporte depuis son planning, et
  // cet onglet n'est que la LISTE des rapports. Il porte le module `FIELD_REPORTS` : la console décide toujours qui le
  // voit (la Direction et les managers : tous les rapports ; un délégué : les siens). `/field-reports` y REDIRIGE.
  { module: "FIELD_REPORTS", label: "Rapports", href: CHEMIN_RAPPORTS_TERRAIN },
  // PLUS D'ONGLET « ANNUAIRE » (Direction, 06/10) : les praticiens se tiennent dans Annuaires › Médecins / Pharmaciens.
  // PLUS D'ONGLET « ÉTABLISSEMENTS » ICI (décision de la Direction, 09/2026 — §118.138) : « on
  // les crée et on les gère depuis les Annuaires ». Le référentiel des hôpitaux ne vit donc plus
  // qu'à UN endroit, Administration › Annuaires › Établissements. Deux portes vers le même
  // référentiel n'était pas une fuite — les deux lisaient le même chargeur — mais c'était deux
  // endroits où chercher, et la Direction a tranché lequel garder. `/medical/etablissements`
  // REDIRIGE (les liens déjà envoyés restent valides).
];

/**
 * ANNUAIRES — le sous-module du pôle Administration qui centralise TOUS les annuaires.
 *
 * Demande de la Direction (09/2026) : « un module à part dans Administration nommé Annuaires qui
 * contiendra tous les annuaires (partenaires, médecins, pharmaciens, établissements, et autres),
 * tous centralisés ». Chaque onglet porte le MODULE du référentiel qu'il montre : c'est lui qui
 * décide de son affichage (`visibleTabs`), pas la porte « Annuaires » — un onglet Médecins
 * visible à qui n'a pas la Promotion médicale serait une fuite par le menu.
 *
 * Les écrans de chaque onglet rendent les MÊMES composants et lisent les MÊMES chargeurs que les
 * pages des modules d'origine (`lib/queries/annuaires.ts`) : deux écrans qui chargent
 * séparément le même annuaire divergent, toujours (§118.5).
 */
export const ANNUAIRES_TABS: NavTab[] = [
  { module: "MEDICAL", label: "Médecins", href: "/annuaires/medecins", annuaire: "MEDECINS" },
  { module: "MEDICAL", label: "Pharmaciens", href: "/annuaires/pharmaciens", annuaire: "PHARMACIENS" },
  { module: "MEDICAL", label: "Établissements", href: "/annuaires/etablissements", annuaire: "ETABLISSEMENTS" },
  // LES SPÉCIALITÉS REVIENNENT DANS LES ANNUAIRES (Direction, 07/10 : « Spécialités → Annuaires ») — porte UNIQUE ;
  // les anciennes adresses (Marketing cockpit, Force de vente) y mènent. Le référentiel suit `peutGererSpecialites`
  // (la Promotion médicale, les directeurs des opérations, la Direction Marketing), pas une case d'annuaire.
  { module: "MEDICAL", label: "Spécialités", href: "/annuaires/specialites", regle: "specialites" },
  // « Autres annuaires » disparaît : ses fournisseurs deviennent un annuaire à part entière ;
  // les partenaires du courrier et les lieux de stock restent dans leurs modules.
  { module: "WORKSPACE", label: "Partenaires", href: "/annuaires/partenaires", annuaire: "PARTENAIRES" },
  { module: "WORKSPACE", label: "Partenaires publics", href: "/annuaires/partenaires-publics", annuaire: "PARTENAIRES_PUBLICS" },
  { module: "DIRECTORIES", label: "Fournisseurs Regulatory", href: "/annuaires/fournisseurs", annuaire: "FOURNISSEURS" },
  { module: "WORKSPACE", label: "Personnes", href: "/annuaires/personnes", annuaire: "PERSONNES" },
];

/**
 * LE SITE PUBLIC (§118.158) — trois écrans d'un même module : l'état de la publication (ce qui est
 * en ligne, en file, refusé ; la réconciliation quotidienne), les articles de blog, et les offres
 * d'emploi. Les offres s'ÉCRIVENT par les RH (droit `RH` en écriture), qui y arrivent aussi depuis
 * le Recrutement ; l'onglet les montre à qui tient le module, en lecture.
 */
export const SITE_WEB_TABS: NavTab[] = [
  { module: "SITE_WEB", label: "Publication", href: "/site-web" },
  { module: "SITE_WEB", label: "Articles", href: "/site-web/articles" },
  { module: "SITE_WEB", label: "Offres d'emploi", href: "/site-web/offres" },
  { module: "SITE_WEB", label: "Audience", href: "/site-web/audience" },
];

export const NAVIGATION: NavItem[] = [
  // Pilotage — « Mon espace » regroupe désormais Mon travail, Mon espace, Dashboard, Calendrier
  // (onglets). `match` couvre ces routes pour l'état actif de la barre latérale. Les Directives n'en font plus partie (07/10).
  { module: "WORKSPACE", label: "Mon espace", href: "/mon-espace", icon: "LayoutGrid", group: "Pilotage", tabs: WORKSPACE_TABS, match: ["/mon-travail", "/mon-dossier", "/missions", "/pieces"] },
  { module: "WORKSPACE", label: "Agenda", href: "/calendar", icon: "CalendarDays", group: "Pilotage", tabs: AGENDA_TABS, match: ["/meetings"] },
  // Assistant IA : MODULE À PART ENTIÈRE (l'ancienne bulle flottante a été retirée) —
  // page plein écran avec dictée vocale et lecture de pièces jointes.
  // ADAM (l'assistant ET le chief of staff) n'est visible que du Super Admin (§118.153, `peutVoirAdam`).
  { module: "WORKSPACE", label: "Assistant IA", href: "/assistant", icon: "Sparkles", group: "Pilotage", gate: "adam" },
  // LE CENTRE DE MISSIONS — le PARC de ce qu'Adam exécute. Il vit à côté de l'assistant et pas
  // dedans : une mission est un objet de l'ERP (identifiant, propriétaire, étapes, livrables,
  // journal), et la ranger dans la conversation ferait dépendre son écran de l'assistant, ce
  // que le cliquet de frontière mesure et fait baisser lot après lot. `/missions/<id>` — où
  // pointent toutes ses notifications — reste son adresse ; ceci en est la liste, qui manquait.
  // RÉSERVÉ AU SUPER ADMIN (décision de la Direction, 09/2026) : la garde `adamMissions` lit
  // `peutPiloterMissionsAdam` dans `nav-access.ts` — l'entrée n'est pas envoyée aux autres.
  { module: "WORKSPACE", label: "Missions d'Adam", href: "/centre-de-missions", icon: "Radar", group: "Pilotage", match: ["/centre-de-missions"], gate: "adamMissions" },
  // « MY CHIEF OF STAFF » — l'interface exécutive de pilotage, réservée au PDG et au Super
  // Admin (module CHIEF_OF_STAFF). Même moteur que l'assistant, mais les outils d'un chef de
  // cabinet : histoire complète d'un dossier, lecture des documents, bilans, rappels planifiés,
  // décisions du centre de paiement.
  { module: "CHIEF_OF_STAFF", label: "My Chief of Staff", href: "/chief-of-staff", icon: "Crown", group: "Pilotage", gate: "adam" },
  { module: "DOSSIERS", label: "Sujets", href: "/dossiers", icon: "ClipboardList", group: "Pilotage" },
  // Messagerie Microsoft 365 — sous le module MESSAGING (droit déjà existant) ; l'ouverture réelle
  // dépend en plus du drapeau MICROSOFT_MAIL et de la liste pilote, vérifiés dans l'écran.
  // Elle est dans PILOTAGE et non dans Transverse : on relève ses mails en même temps qu'on
  // regarde son espace et son calendrier, pas en même temps qu'on range un fichier.
  { module: "MESSAGING", label: "Messagerie e-mail", href: "/messagerie", icon: "Mail", group: "Pilotage" },
  // « Courrier » (boîte mail intégrée) retiré de la plateforme — la messagerie e-mail se gère
  // désormais directement dans l'app Infomaniak. Le code back-end reste dormant (non exposé).
  // ─────────────────────────── PÔLES D'ENTREPRISE ───────────────────────────
  // Les routes ne changent PAS : seul le rangement change. Un lien de notification écrit il y a
  // six mois reste donc valide, sans redirection.

  // REGULATORY — le suivi d'un dossier a SA porte : une assistante qui suit un dossier n'a pas à
  // traverser toute l'interface d'analyse CTD pour y arriver.
  { module: "REGULATORY", label: "Suivi des dossiers", href: "/regulatory", icon: "FileCheck2", group: "Pôles", pole: "REGULATORY" },
  // Le PIPELINE est un module du pôle REGULATORY, au même rang que le suivi des dossiers : il se
  // découvre en dépliant la flèche de Regulatory. Ce sont les dossiers verrouillés — ce qu'on
  // étudie sans l'avoir encore ouvert à l'équipe.
  // GARDE `pipeline` : l'entrée ne s'affiche que pour qui voit RÉELLEMENT des dossiers
  // verrouillés (accès réglé en Administration). Sans elle, tout le pôle Regulatory voyait un
  // menu menant à un écran vide — et se demandait ce qu'il avait manqué.
  // SON PROPRE MODULE (Direction, 08/10 : « sépare Pipeline et Suivi de dossiers dans les accès ») : la console
  // l'ouvre ou le ferme personne par personne, indépendamment du suivi des dossiers.
  { module: "REGULATORY_PIPELINE", label: "Pipeline", href: "/regulatory/pipeline", icon: "GitBranch", group: "Pôles", pole: "REGULATORY", gate: "pipeline" },
  { module: "REGULATORY", label: "Analyse CTD", href: "/regulatory/enregistrement", icon: "ScanSearch", group: "Pôles", pole: "REGULATORY", gate: "regEnrollment" },
  // INFORMATION MÉDICALE — décision de la Direction (09/2026) : elle passe de Sales & Marketing
  // au pôle REGULATORY. Une déclaration d'information médicale est un acte réglementaire, pas
  // un acte de promotion, et la ranger sous la force de vente laissait entendre le contraire.
  //
  // SEUL LE PÔLE CHANGE, PAS LES DROITS. `pole` ne sert qu'à `groupIntoPoles` — le regroupement
  // du menu — et rien du contrôle d'accès ne le lit : la garde reste le MODULE `MEDICAL_INFO`,
  // avec exactement les mêmes titulaires qu'hier. Déplacer une entrée de menu ne doit jamais
  // ouvrir ni fermer un écran à quiconque, et c'est vérifié (`navigation.test.ts`).
  { module: "MEDICAL_INFO", label: "Information médicale", href: "/information-medicale", icon: "ShieldPlus", group: "Pôles", pole: "REGULATORY" },
  // PHARMACOVIGILANCE (Direction, 06/10) — la boîte de réception des cas signalés par les KAM. GARDE
  // `pharmacovigilance` : l'entrée ne s'affiche qu'à qui reçoit les cas (portée TOUT) ; le KAM, qui ne lit que ses
  // signalements, les retrouve dans les Rapports terrain — il n'a rien à faire dans le pôle Regulatory.
  { module: "PHARMACOVIGILANCE", label: "Pharmacovigilance", href: "/regulatory/pharmacovigilance", icon: "ShieldAlert", group: "Pôles", pole: "REGULATORY", gate: "pharmacovigilance" },
  // BUDGET REGULATORY (Direction, 08/10) — les BV 25 % / 75 % des dossiers et les frais réglementaires.
  { module: "BUDGET_REGULATORY", label: "Budget Regulatory", href: "/budget-regulatory", icon: "PiggyBank", group: "Pôles", pole: "REGULATORY", tabs: BUDGET_REGULATORY_TABS, match: ["/budget-regulatory"] },

  // ADMINISTRATION — l'administration de L'ENTREPRISE (à ne pas confondre avec la Console
  // d'Administration, qui est celle du logiciel et vit dans « Système »).
  // MOYENS GÉNÉRAUX — L'ENTRÉE SUIT LE MODULE, comme partout ailleurs.
  //
  // Elle était portée par WORKSPACE — que tout le monde a — du temps où la page servait aussi à
  // DEMANDER un achat : le module retenu ouvrait le catalogue à tous, et le budget restait gardé
  // à l'intérieur. Les demandes d'achat ont déménagé dans « Mon espace », et la page refuse
  // désormais l'entrée à qui n'a pas `GENERAL_MEANS` : l'entrée de menu promettait donc un écran
  // qui répond « ce n'est pas pour vous ».
  //
  // Pire, cela faisait mentir la console : un administrateur BLOQUE les Moyens généraux à
  // quelqu'un, et la personne continue de voir l'entrée dans son menu. Elle en conclut que le
  // blocage n'a pas pris — c'est le défaut rapporté sur deux comptes.
  //
  // L'entrée porte donc le MÊME module que sa page. Un droit qui ne se lit pas là où on le règle
  // n'est pas administrable, et un menu qui ne dit pas la vérité sur les droits non plus.
  {
    module: "GENERAL_MEANS", label: "Moyens généraux", href: "/moyens-generaux", icon: "ShoppingBasket",
    group: "Pôles", pole: "ADMINISTRATION",
    // L'ANNUAIRE DE L'ENTREPRISE A DÉMÉNAGÉ DANS « MON ESPACE » (onglet à part).
    //
    // C'est un carnet d'adresses, pas un outil de caisse : l'imprimeur, le transitaire et
    // l'agence de voyage sont cherchés par tout le monde, et le ranger derrière un module que
    // la plupart des gens n'ouvrent jamais revenait à le rendre introuvable pour ceux à qui il
    // sert. Les Moyens généraux gardent un lien vers lui — c'est le service qui traite avec eux
    // —, mais l'écran vit désormais où on le cherche.
  },
  // FINANCES — DEUX SOUS-MODULES, DANS LE MENU et nulle part ailleurs.
  //
  // Ils ont d'abord été des onglets DANS la page : deux chemins pour la même chose, et une barre
  // d'onglets qui redisait sous chaque titre ce que le menu montrait déjà à gauche. Le menu suffit
  // — on déplie la flèche et l'on arrive directement là où l'on va travailler.
  //
  // LE « DASHBOARD » A DISPARU (2026-09). Il ne portait aucun geste : on y regardait la
  // trésorerie, puis on allait travailler ailleurs — un écran d'escale entre le menu et le vrai
  // écran. Le solde de la banque a rejoint « Banque & paiements », là où l'on décide ce qu'on
  // paie ; le cockpit du DAF a rejoint la Comptabilité, là où il devient des écritures.
  //
  // L'ENTRÉE PARENTE MÈNE DONC À « Banque & paiements » : cliquer « Finances » ne doit pas
  // conduire à une page d'accueil vide qu'il faut quitter aussitôt. `/finances` reste dans le
  // `match` — l'adresse survit par une redirection, et le menu ne doit pas se désélectionner
  // pour ceux qui arrivent par un lien ou un favori.
  {
    module: "FINANCES", label: "Finances", href: "/finances/paiements-a-faire", icon: "Landmark", group: "Pôles", pole: "ADMINISTRATION",
    match: ["/finances", "/finances/comptabilite"],
    children: [
      { module: "FINANCES", label: "Banque & paiements", href: "/finances/paiements-a-faire", icon: "Banknote", group: "Pôles", pole: "ADMINISTRATION" },
      { module: "FINANCES", label: "Comptabilité", href: "/finances/comptabilite", icon: "BookOpen", group: "Pôles", pole: "ADMINISTRATION" },
    ],
  },
  // LES BONS DE COMMANDE — un module À PART (décision de la Direction, 01/10/2026, §118.176).
  //
  // C'était le troisième sous-module des Finances (§118.149) : « les bons de commande à signer de
  // leur part. Si un BC se retrouve là-bas, c'est qu'il doit être signé. » La file n'a pas changé ;
  // sa PORTE, si : « le module bon de commande doit être à part et le super admin donne les accès à
  // qui il veut ». Rangé sous les Finances, il s'ouvrait à quiconque lisait les Finances, et l'on ne
  // pouvait ni le donner à quelqu'un qui ne les a pas, ni le retirer à quelqu'un qui les a.
  { module: "PURCHASE_ORDERS", label: "Bons de commande", href: CHEMIN_BONS_DE_COMMANDE, icon: "FilePen", group: "Pôles", pole: "ADMINISTRATION" },
  // LE CENTRE DE PAIEMENT — un module À PART, HORS Finances : celui qui autorise l'argent ne
  // doit pas être dans l'écran de celui qui le décaisse. L'entrée n'apparaît qu'à qui a le
  // module (PDG + Super Admin) ; un demandeur à qui le centre rend la main y arrive par le LIEN
  // de sa notification — pas par le menu.
  { module: "PAYMENT_CENTRE", label: "Centre de paiement", href: "/centre-de-paiement", icon: "ShieldCheck", group: "Pôles", pole: "ADMINISTRATION" },
  // LE CENTRE DE VALIDATIONS — le pendant du précédent, côté DÉCISIONS, pour le Directeur
  // Général et le Super Admin. Un écran qui ne contient QUE ce qu'on attend d'eux, tous modules
  // confondus : dans l'écran commun des validations, ces demandes se noyaient entre leurs
  // propres dossiers et les blocs de suivi, et l'on découvrait une signature attendue depuis six
  // jours en cherchant autre chose.
  { module: "VALIDATION_CENTRE", label: "Centre de validations", href: "/centre-de-validations", icon: "Gavel", group: "Pôles", pole: "ADMINISTRATION" },
  // LE CENTRE DE VALIDATION AD & PRO — le TROISIÈME centre (décision de la Direction, 09/2026).
  // Toute demande Ad & Pro dont le budget total dépasse le seuil s'y arrête, et le SEUIL se
  // règle depuis cet écran. Il siège avec les deux autres centres et non dans Ad & Pro : celui
  // qui arbitre une dépense de 1,2 M ne doit pas être dans l'écran de celui qui la demande.
  { module: "AD_PRO_CENTRE", label: "Centre de validation Ad & Pro", href: "/centre-ad-pro", icon: "Scale", group: "Pôles", pole: "ADMINISTRATION" },
  // LES DEMANDES DE PAIEMENT n'ont PLUS d'entrée de menu : la demande se fait depuis les
  // Demandes de validations (bouton « Demande de paiement »), et une fois le bon à payer donné,
  // le dossier passe par le centre de paiement puis atterrit dans les Règlements à effectuer.
  // Les écrans /validations/paiements restent servis — on y arrive par le bouton et les liens.
  // LA PAIE EST UN SOUS-MODULE DES RH, pas un onglet de plus. Elle n'a pas la même
  // audience que le reste du module : les congés, l'équipe et les départements se lisent
  // largement, la paie ne s'ouvre qu'à qui TIENT les RH (`gate: "payroll"` = droit de mise à
  // jour). Un onglet l'aurait affichée à tout le monde pour la refuser au clic ; en enfant,
  // elle se déplie par la flèche — sur ordinateur comme sur mobile — et n'apparaît qu'à ceux
  // qui peuvent l'ouvrir. Elle reste servie par sa propre route, gardée par sa propre page.
  {
    // UN GROUPE (Direction, 06/10) : « RH » garde le tableau de bord des RH, la paie et les avances ; Employés, Demandes RH
    // et Formations sont des modules à part. L'entrée s'ouvre dès qu'UN de ses sous-modules est ouvert.
    module: "RH", label: "Ressources humaines", href: "/rh", icon: "UsersRound", group: "Pôles",
    pole: "ADMINISTRATION", groupe: true,
    children: [
      { module: "EMPLOYEES", label: "Employés", href: "/rh/equipe", icon: "Users", group: "Pôles", pole: "ADMINISTRATION", match: ["/rh/consultants", "/rh/departements"] },
      { module: "HR_REQUESTS", label: "Demandes RH", href: "/rh/demandes", icon: "Inbox", group: "Pôles", pole: "ADMINISTRATION", match: ["/rh/conges"] },
      // RECRUTEMENT — un module à part sous les RH (Direction, 07/10) : n'importe qui y demande un poste, la chaîne
      // remonte jusqu'au DG, puis les RH publient et diffusent. Ses accès se règlent dans la console, comme les autres.
      { module: "RECRUITMENT", label: "Recrutement", href: "/recrutement", icon: "UserPlus", group: "Pôles", pole: "ADMINISTRATION", match: ["/recrutement"] },
      { module: "TRAINING", label: "Formations", href: "/formations", icon: "GraduationCap", group: "Pôles", pole: "ADMINISTRATION" },
      { module: "RH", label: "Paie", href: "/rh/paie", icon: "Banknote", group: "Pôles", pole: "ADMINISTRATION", gate: "payroll" },
    ],
  },
  // LEGAL — les engagements de la société : contrats, bons de commande, assurances, baux. Le
  // fichier reste dans le Drive ; Legal porte ce que le Drive ne sait pas dire (dates, échéance,
  // partie en face) et rappelle avant l'échéance.
  {
    module: "LEGAL", label: "Legal", href: "/legal", icon: "Scale", group: "Pôles", pole: "ADMINISTRATION",
    // Les COORDONNÉES LÉGALES & FISCALES de chaque entité vivent sous Legal : ce sont les
    // numéros par lesquels la société s'engage, et on les cherche là où l'on range ses engagements.
    //
    // LES FACTURES N'ONT PAS D'ENTRÉE, et c'est le sujet. Elles ne sont pas un endroit : ce sont
    // des documents légaux de NATURE « facture », dans la même liste que les devis et les bons
    // de commande dont elles découlent. `/legal?nature=INVOICE` en est une VUE — un filtre de
    // colonne prérempli, retirable d'un clic. Lui donner un onglet recréerait, sous un autre
    // nom, l'écran séparé qu'on vient de fermer.
    children: [
      { module: "LEGAL", label: "Coordonnées des entités", href: "/legal/identites", icon: "IdCard", group: "Pôles", pole: "ADMINISTRATION" },
    ],
  },
  // COURRIERS — le carnet entrant/sortant de l'assistante de direction.
  { module: "MAIL_REGISTER", label: "Courriers", href: "/courriers", icon: "Mails", group: "Pôles", pole: "ADMINISTRATION" },
  // ANNUAIRES — tous les annuaires de l'entreprise en un seul sous-module (décision de la
  // Direction, 09/2026). L'entrée est visible dès qu'UN onglet l'est, et mène au premier
  // onglet autorisé : chaque onglet porte le module de son référentiel.
  {
    module: "DIRECTORIES", label: "Annuaires", href: "/annuaires", icon: "BookUser", group: "Pôles",
    pole: "ADMINISTRATION", tabs: ANNUAIRES_TABS, match: ["/annuaires"],
  },
  // MON ÉQUIPE — l'écran de celui qui ENCADRE. Une entrée simple : le RECRUTEMENT en est sorti pour devenir un
  // module à part sous « Ressources humaines » (Direction, 07/10) — n'importe qui peut demander un poste, pas
  // seulement l'encadrant.
  { module: "MY_TEAM", label: "Mon Équipe", href: "/mon-equipe", icon: "Users", group: "Pilotage", gate: "myTeam" },
  { module: "BUDGETS", label: "Budgets", href: "/budgets", icon: "Wallet", group: "Pôles", pole: "ADMINISTRATION", tabs: BUDGET_TABS, match: ["/budgets/depenses", "/budgets/departements", "/budgets/business-units", "/budgets/reglages"] },
  // LA CAMPAGNE BUDGÉTAIRE (Budgets 2027, Direction 10/2026) — chaque pôle prépare, le comité valide, les enveloppes de
  // l'année s'ouvrent d'elles-mêmes. Un responsable de département y entre par l'organigramme (accès implicite).
  { module: "BUDGET_CAMPAIGN", label: "Campagne budgétaire", href: "/budget-campagne", icon: "PiggyBank", group: "Pôles", pole: "ADMINISTRATION", match: ["/budget-campagne"] },

  // MARKETING — séparé de « Operations & Sales » (Direction, 08/10 : « sépare Marketing et Sales »). Ce que la
  // Direction Marketing tient : son cockpit, la segmentation, les produits, Ad & Pro, le stock promotionnel et le site
  // public (« le module du site web passe également au département marketing »). Les droits ne bougent pas : seul le
  // rangement du menu change.
  // MARKETING COCKPIT — le tableau de la Direction Marketing (07/10) : une page, ses vues par `?vue=` (barre rendue par la
  // page, `MARKETING_COCKPIT_TABS`) — d'où l'absence de `tabs` ici.
  { module: "MARKETING_COCKPIT", label: "Marketing cockpit", href: "/marketing-cockpit", icon: "Megaphone", group: "Pôles", pole: "MARKETING", match: ["/marketing-cockpit"] },
  // SEGMENTATION STUDIO — la segmentation native : stratégie par BU, règles versionnées, panel calculé et expliqué.
  { module: "SEGMENTATION", label: "Segmentation", href: "/segmentation", icon: "Layers", group: "Pôles", pole: "MARKETING", match: ["/segmentation"] },
  // PRODUITS — chaque produit canonique et sa vue 360° (réglementaire, AO, ventes, segmentation, consommation, coûts).
  // Un MODULE À PART (Direction, 06/10) : ses accès se règlent dans la console, comme les autres.
  { module: "PRODUCTS", label: "Produits 360", href: "/produits", icon: "Pill", group: "Pôles", pole: "MARKETING", match: ["/produits"] },
  // « RAPPORTS TERRAIN » N'EST PLUS UNE ENTRÉE (Direction, 07/10) : c'est l'onglet « Rapports » de la Promotion médicale
  // (`MEDICAL_TABS`, module `FIELD_REPORTS`). `/field-reports` redirige ; l'entrée médicale le couvre par `match`.
  { module: "SPONSORING", label: "Ad & Pro", href: "/ad-pro", icon: "PartyPopper", group: "Pôles", pole: "MARKETING", tabs: EVENTS_TABS, match: ["/sponsoring", "/promo-material", "/consulting"] },
  // BUDGET MARKETING (Direction, 08/10) — les enveloppes Ad & Pro et celles de la Direction Marketing. Les mêmes lignes
  // que Budgets (pôle Administration), qui les montre en lecture seule.
  { module: "BUDGET_MARKETING", label: "Budget Marketing", href: "/budget-marketing", icon: "PiggyBank", group: "Pôles", pole: "MARKETING", tabs: BUDGET_MARKETING_TABS, match: ["/budget-marketing"] },
  // LE STOCK PROMOTIONNEL — son propre sous-module (§118.173), et plus un onglet d'Ad & Pro.
  { module: "PROMO_STOCK", label: "Stock promotionnel", href: CHEMIN_STOCK_PROMO, icon: "Warehouse", group: "Pôles", pole: "MARKETING", tabs: STOCK_PROMO_TABS, match: [CHEMIN_STOCK_PROMO] },
  // LE SITE PUBLIC (§118.158) — l'ERP y publie les offres d'emploi et les articles de blog. Rangé sous Marketing
  // (Direction, 08/10) ; ses accès restent les siens (module `SITE_WEB`, onglets `SITE_WEB_TABS`).
  { module: "SITE_WEB", label: "Site web", href: "/site-web", icon: "Globe", group: "Pôles", pole: "MARKETING", tabs: SITE_WEB_TABS, match: ["/site-web"] },

  // OPERATIONS & SALES — le terrain et le business réalisé (Direction, 08/10) : la promotion médicale, le montage des
  // BU, la force de vente, les marchés PCH — puis les ventes et la consommation, qui étaient dans le même pôle. L'annuaire
  // des praticiens vit DANS Promotion médicale : on ne consulte pas un annuaire pour lui-même, on le consulte en
  // préparant une visite.
  // PROMOTION MÉDICALE — deux onglets, et l'ordre compte : « Ma journée » d'abord, parce que
  // c'est l'écran quotidien du terrain (sa tournée, sa saisie de visite en trois gestes) ;
  // l'annuaire ensuite, qui est le référentiel. L'ancien « Visites & segmentation » retiré est
  // remplacé par cette journée — les visites en base n'ont jamais bougé, et elle les relit.
  // COCKPIT OPÉRATIONS — la PREMIÈRE entrée du pôle (Direction, 08/10) : l'écran de tête du directeur des opérations.
  { module: "COCKPIT_OPERATIONS", label: "Cockpit Opérations", href: "/operations", icon: "Gauge", group: "Pôles", pole: "OPERATIONS_SALES", match: ["/operations"] },
  { module: "MEDICAL", label: "Promotion médicale", href: "/medical/ma-journee", icon: "Stethoscope", group: "Pôles", pole: "OPERATIONS_SALES", tabs: MEDICAL_TABS, match: ["/medical", "/field-reports"] },
  { module: "SALES_PLANNING", label: "Force de vente", href: "/planning", icon: "Target", group: "Pôles", pole: "OPERATIONS_SALES", tabs: SALES_PLANNING_TABS, match: ["/planning"] },
  // BUSINESS UNITS — le montage de la force de vente, sorti du « ⋯ Réglages » de la Force de vente (Direction, 08/10) :
  // les BU et leurs quatre étapes, les secteurs, les paramètres. Son propre module (`BUSINESS_UNITS`).
  { module: "BUSINESS_UNITS", label: "Business Units", href: "/business-units", icon: "Building2", group: "Pôles", pole: "OPERATIONS_SALES", tabs: BUSINESS_UNITS_TABS },
  { module: "PCH", label: "Marchés PCH", href: "/pch", icon: "Gavel", group: "Pôles", pole: "OPERATIONS_SALES" },
  // VENTES PCH — remplace « Ventes » (saisie manuelle, `SALES` retiré du service) : les fichiers de la PCH, lus par BU.
  // L'historique de l'ancienne saisie reste lisible, en lecture seule, dans son onglet.
  { module: "PCH_VENTES", label: "Ventes PCH", href: "/sales", icon: "TrendingUp", group: "Pôles", pole: "OPERATIONS_SALES", tabs: VENTES_PCH_TABS, match: ["/sales"] },
  // LA CHAÎNE PHYSIQUE REJOINT LE PÔLE (Direction, 08/10 : « Stocks et Logistique rejoignent Operations & Sales ») — le
  // pôle « Supply Chain & Logistics » disparaît. Stocks : la chaîne Adventum + PCH central + hôpitaux, par BU.
  // Logistique : son module reste RETIRÉ du service (`modules-retired.ts`) — l'entrée est rangée ici, et ne s'affiche
  // pour personne tant que le retrait n'est pas levé.
  { module: "STOCKS", label: "Stocks", href: "/stocks", icon: "Boxes", group: "Pôles", pole: "OPERATIONS_SALES" },
  { module: "LOGISTICS", label: "Logistique", href: "/logistics", icon: "Truck", group: "Pôles", pole: "OPERATIONS_SALES" },
  // CONSUMPTION INTELLIGENCE n'a PLUS d'entrée de menu (Direction, 08/10 : « supprime ce module Consommation ou masque-le
  // de ma vue »). Seule l'ENTRÉE part : les écrans `/consommation`, leurs données et le module `CONSUMPTION` restent — ils
  // nourrissent l'affinité de la segmentation et la fiche Produits 360, qui y mènent encore par leurs liens.
  // BUDGET OPERATIONS & SALES (Direction, 08/10) — la masse salariale de la force de vente et les dépenses hors Ad & Pro.
  { module: "BUDGET_OPERATIONS", label: "Budget Operations & Sales", href: "/budget-operations", icon: "PiggyBank", group: "Pôles", pole: "OPERATIONS_SALES", tabs: BUDGET_OPERATIONS_TABS, match: ["/budget-operations"] },

  // BUSINESS DEVELOPMENT — l'AVANT-VENTE : ce qu'on étudie et ce qu'on vise. Les ventes
  // réalisées sont passées dans Operations & Sales (avec les marchés PCH, 08/10) : analyser une opportunité et constater un
  // chiffre d'affaires ne sont pas le même métier.
  // BUSINESS DEVELOPMENT — « Projets » est un SOUS-MODULE, pas un onglet : c'est son propre
  // écran, avec sa propre question. Le tableau stratégique demande « où en est ce projet ? » ;
  // « Projets » demande « qu'est-ce que ce projet contient, dossier par dossier ? ». Le
  // classement se pose dans Regulatory, il se LIT ici.
  // MARKET INTELLIGENCE est RETIRÉ du service (2026-09) ; « Projets » a été redemandé et lui
  // survit seul. L'entrée n'est donc plus un parent avec un enfant — le parent ouvrirait une
  // adresse qui ne s'ouvre plus.
  // « PROJETS » EST SON PROPRE MODULE, `BD_PROJECTS` (§118.163). Il survivait au retrait par un
  // chemin « maintenu » et une garde déduite de Regulatory, que personne ne pouvait régler :
  // l'entrée s'affiche désormais comme toutes les autres, parce que la personne a le module, et
  // le Super Admin l'ouvre ou la ferme dans Administration › Accès.
  { module: "BD_PROJECTS", label: "Projets", href: "/business-development/projets", icon: "FolderKanban", group: "Pôles", pole: "BUSINESS_DEV" },
  // L'EXPLORATEUR PRODUITS — module à part, et non plus une sous-page d'Intelligence marché.
  // On ne l'ouvre pas « en analysant le marché » : on l'ouvre parce qu'on cherche UN produit,
  // UNE molécule, UN laboratoire. C'était le geste le plus fréquent du pôle, et il fallait deux
  // clics et connaître le chemin pour y arriver.
  { module: "PRODUCT_EXPLORER", label: "Explorateur produits", href: "/explorateur-produits", icon: "PackageSearch", group: "Pôles", pole: "BUSINESS_DEV", match: ["/business-development/marche/produits"] },

  // Transverse — « Demandes de validations » est le bureau de validation : chacun
  // y demande une validation professionnelle (selon l'accès accordé par le Super
  // Admin), et les validateurs y traitent ce qui leur revient. Les validations en
  // attente restent aussi visibles dans « Mon espace » (Action Center).
  { module: "VALIDATIONS", label: "Demandes de validations", href: "/validations", icon: "ShieldCheck", group: "Transverse" },
  { module: "DRIVE", label: "Drive", href: "/drive", icon: "FolderOpen", group: "Transverse", tabs: DOCS_TABS },
  // BUREAUTIQUE N'A PLUS D'ENTRÉE : créer un document Word/Excel/PowerPoint est le bouton
  // « Nouveau document » du Drive, et la papeterie de la société est dans son menu « ⋯ ».
  // Un second écran pour les mêmes fichiers finissait par en donner une seconde liste.
  { module: "ADMIN_REQUESTS", label: "Bureau du secrétariat", href: "/demandes", icon: "ClipboardList", group: "Transverse" },
  // DIRECTION ARTISTIQUE (10/2026) — la papeterie de chaque entité (en-têtes, modèles de pièces, PowerPoint, Excel, logo
  // et charte), tenue par l'assistante de direction. La fabrique y lit le modèle d'un bon de commande.
  { module: "ART_DIRECTION", label: "Direction artistique", href: "/direction-artistique", icon: "Palette", group: "Transverse" },
  // FEEDBACK — module à part, donc réglable : accès par rôle ou par personne, et masquable
  // depuis la console d'administration comme n'importe quel autre. Rattaché à « espace de
  // travail », il était ouvert à tous sans qu'on puisse ni le fermer ni le retirer.
  { module: "FEEDBACK", label: "Feedback", href: "/feedback", icon: "MessageSquarePlus", group: "Transverse" },
  // Système
  { module: "ADVENTUM_BRAIN", label: "Adventum Brain", href: "/adventum-brain", icon: "BrainCircuit", group: "Système", tabs: BRAIN_TABS },
  // « Console d'Administration » et non « Administration » : l'administration de
  // L'ENTREPRISE est un pôle métier (Moyens généraux / Finances / RH / Budgets). Les
  // confondre, c'est envoyer un directeur financier dans les réglages techniques.
  { module: "ADMIN", label: "Console d'Administration", href: "/admin", icon: "Settings", group: "Système", tabs: ADMIN_TABS },
  // LA CORBEILLE DE SES MODULES — le directeur des opérations y récupère ce qui a été supprimé chez lui (06/10).
  // Le module WORKSPACE est à tout le monde : c'est la garde `corbeilleOps` qui ouvre l'entrée.
  { module: "WORKSPACE", label: "Corbeille", href: "/corbeille", icon: "Trash2", group: "Système", gate: "corbeilleOps" },
];

/**
 * Première destination de navigation que `canView` autorise — pour un atterrissage
 * **sûr** après un refus (jamais une page qui refuserait à nouveau → anti-boucle
 * `ERR_TOO_MANY_REDIRECTS`). On ignore les **sous-pages d'admin** (`/admin/…`),
 * gardées par un contrôle plus strict que VIEW ; « /admin » (VIEW) reste valide.
 * Renvoie `null` si l'utilisateur ne peut voir aucune destination.
 */
/**
 * Module « propriétaire » d'un chemin — pour router une notification (via son lien) vers l'entrée
 * de menu concernée et y poser un badge. Renvoie le module de l'entrée (ou d'un onglet) dont le
 * href/match est le plus long préfixe du chemin ; `null` si aucune ne correspond.
 */
/**
 * LIBELLÉS HISTORIQUES → module.
 *
 * `ValidationRequest.module` stocke le LIBELLÉ tel qu'il était au moment de la demande. Renommer
 * une entrée de menu casserait donc l'accès temporaire d'un validateur sur toute demande créée
 * avant le renommage — il ouvrirait une page vide sans comprendre pourquoi.
 *
 * Cette table conserve les anciens noms. On n'en retire JAMAIS une ligne : les demandes
 * historiques, elles, ne se renomment pas.
 */
export const NAV_LEGACY_LABELS: Record<string, Module> = {
  "Regulatory": "REGULATORY",
  "Ventes & Marchés": "SALES",
  "Logistique": "LOGISTICS",
  "PCH — Marchés": "PCH",
  "Prévisions & Force de vente": "SALES_PLANNING",
  "Business Development": "BUSINESS_DEVELOPMENT",
  "Explorateur produits": "PRODUCT_EXPLORER",
  "Administration": "ADMIN",
};

export function moduleForPath(path: string): Module | null {
  let bestLen = -1;
  let bestModule: Module | null = null;
  const consider = (href: string, module: Module) => {
    if (href && (path === href || path.startsWith(`${href}/`)) && href.length > bestLen) {
      bestLen = href.length;
      bestModule = module;
    }
  };
  for (const n of NAVIGATION) {
    if (n.tabs) for (const t of n.tabs) consider(t.href, t.module);
    consider(n.href, n.module);
    for (const m of n.match ?? []) consider(m, n.module);
  }
  return bestModule;
}

export function firstAccessibleHref(canView: (module: Module) => boolean): string | null {
  for (const n of NAVIGATION) {
    if (n.href.startsWith("/admin/")) continue;
    if (n.tabs) {
      const t = n.tabs.find((tab) => canView(tab.module));
      if (t) return t.href;
    } else if (canView(n.module)) {
      return n.href;
    }
  }
  return null;
}
