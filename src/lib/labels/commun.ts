/**
 * Libellés — le vocabulaire TRANSVERSE : rôles, priorité, documents et confidentialité, tâches,
 * types d'entité, segments thérapeutiques, wilayas, validations, notifications, audit, conversations.
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

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

export const TASK_STATUS: Record<string, Display> = {
  REQUESTED: { label: "Demandée", tone: "warning" },
  TODO: { label: "À faire", tone: "neutral" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  DONE: { label: "Terminé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
  DECLINED: { label: "Refusée", tone: "danger" },
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
