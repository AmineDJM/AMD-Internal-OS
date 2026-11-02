import type { TestRunMode, TestSeverity } from "@prisma/client";

export type { TestRunMode, TestSeverity };

/** Modes qui créent des données synthétiques (donc nécessitent un nettoyage). */
export const WRITE_MODES: TestRunMode[] = ["SAFE_SYNTHETIC_TEST", "STAGING_FULL_TEST", "CHAOS_TEST"];

export interface RunConfig {
  /** Périmètre (phase 2+) : modules, entités, profondeur… */
  modules?: string[];
  roles?: string[];
  /** Garde production : confirmation explicite + phrase de sécurité (§12). */
  productionConfirmed?: boolean;
  safetyPhrase?: string;
}

/** Un constat de test — persisté en `TestFinding` (preuve expurgée). */
export interface FindingInput {
  severity: TestSeverity;
  category: string; // functional | rbac | data | ux | security | performance | ai | coverage | health
  module?: string | null;
  route?: string | null;
  roleTested?: string | null;
  title: string;
  detail: string;
  evidence?: unknown;
  suggestion?: string | null;
  confidence?: "high" | "medium" | "low" | null;
}

/** Spécification d'une ressource synthétique à inscrire au manifeste. */
export interface ArtifactSpec {
  resourceType: string; // "user" | "document" | "blob" | …
  model?: string | null; // modèle Prisma pour la suppression typée
  recordId: string; // ID RÉEL créé
  blobKey?: string | null;
  dependsOn?: string[]; // IDs (TestArtifact) parents
  deleteMethod?: "prisma" | "blob" | "noop";
}

/** Phrase de sécurité attendue pour toute exécution destructive en production. */
export const PRODUCTION_SAFETY_PHRASE = "CONFIRMER TEST PRODUCTION ADVENTUM";
