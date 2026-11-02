import type { RegProcedureType, RegDossierStatus, RegDocSecurityStatus, RegDocExtractionStatus } from "@prisma/client";

/** Libellés français (UI) des énumérations du Regulatory Intelligence OS. Purs, sans dépendance. */

export const PROCEDURE_TYPE_LABELS: Record<RegProcedureType, string> = {
  PRESUBMISSION: "Pré-soumission",
  INITIAL_REGISTRATION: "Enregistrement initial",
  NEW_ACTIVE_SUBSTANCE: "Nouvelle substance active",
  GENERIC: "Générique",
  BIOSIMILAR: "Biosimilaire",
  IMPORTED: "Produit importé",
  LOCAL_MANUFACTURING: "Fabrication locale",
  ADD_DOSAGE: "Ajout de dosage",
  ADD_PRESENTATION: "Ajout de présentation",
  EXTENSION_INDICATION: "Extension d'indication",
  VARIATION: "Variation (modification)",
  RENEWAL: "Renouvellement",
  TRANSFER: "Transfert",
  RESERVE_RESPONSE: "Réponse aux réserves",
  SUPPLEMENT: "Complément",
  WITHDRAWAL: "Retrait",
  CESSATION: "Cessation",
  OTHER: "Autre",
};

export const PROCEDURE_TYPE_ORDER: RegProcedureType[] = [
  "INITIAL_REGISTRATION", "GENERIC", "BIOSIMILAR", "NEW_ACTIVE_SUBSTANCE", "IMPORTED", "LOCAL_MANUFACTURING",
  "VARIATION", "RENEWAL", "TRANSFER", "ADD_DOSAGE", "ADD_PRESENTATION", "EXTENSION_INDICATION",
  "RESERVE_RESPONSE", "SUPPLEMENT", "PRESUBMISSION", "WITHDRAWAL", "CESSATION", "OTHER",
];

export const DOSSIER_STATUS_LABELS: Record<RegDossierStatus, string> = {
  DRAFT: "Brouillon",
  INGESTING: "Ingestion en cours",
  INGESTED: "Dossier ingéré",
  ANALYSING: "Analyse en cours",
  IN_REVIEW: "En revue",
  SUPPLIER_LOOP: "Échange fournisseur",
  READY_FOR_REVIEW: "Prêt pour revue finale",
  SUBMITTED: "Soumis (ANPP)",
  DECISION: "Décision reçue",
  MAINTAINED: "Maintenu",
  ARCHIVED: "Archivé",
  ERROR: "Erreur",
};

export const DOSSIER_STATUS_TONE: Record<RegDossierStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral",
  INGESTING: "info",
  INGESTED: "info",
  ANALYSING: "info",
  IN_REVIEW: "warning",
  SUPPLIER_LOOP: "warning",
  READY_FOR_REVIEW: "warning",
  SUBMITTED: "success",
  DECISION: "success",
  MAINTAINED: "success",
  ARCHIVED: "neutral",
  ERROR: "danger",
};

export const SECURITY_LABELS: Record<RegDocSecurityStatus, string> = {
  PENDING: "En attente",
  SAFE: "Sain",
  BLOCKED_EXECUTABLE: "Bloqué — exécutable/macro",
  BLOCKED_ENCRYPTED: "Bloqué — chiffré/illisible",
  BLOCKED_PATH: "Bloqué — chemin non sûr",
  BLOCKED_OVERSIZE: "Bloqué — trop volumineux",
  SUSPICIOUS: "À vérifier — archive imbriquée",
  CORRUPTED: "Corrompu",
};

export const EXTRACTION_LABELS: Record<RegDocExtractionStatus, string> = {
  PENDING: "En attente d'extraction",
  TEXT_EXTRACTED: "Texte extrait",
  OCR_REQUIRED: "OCR requis (scan)",
  OCR_COMPLETED: "OCR effectué",
  LOW_CONFIDENCE: "Extraction incertaine",
  CORRUPTED: "Illisible",
  PASSWORD_PROTECTED: "Protégé par mot de passe",
  UNSUPPORTED: "Non pris en charge",
  MANUAL_REVIEW_REQUIRED: "Revue manuelle requise",
};

/** Un statut de sécurité empêche-t-il la conservation du fichier ? */
export function isBlockedSecurity(s: RegDocSecurityStatus): boolean {
  return s.startsWith("BLOCKED") || s === "CORRUPTED";
}

export function humanBytes(n: number): string {
  if (n <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
