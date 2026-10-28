/**
 * Libellés — PRODUITS et RÉGLEMENTAIRE : formes, dosages, fournitures, statuts et étapes des dossiers,
 * canaux et cycle de vie, demandes réglementaires, Business Development, fabrication locale et variations.
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

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
  EMULSION_INJECTABLE: "Émulsion injectable",
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
