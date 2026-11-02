/**
 * RUNNER de jobs Node-first (en base Postgres, sans Redis/BullMQ). Idempotent, verrou
 * optimiste, reprise après verrou expiré, réessais bornés. Déclenché par le planificateur
 * interne (runScheduledJobs) ; borné par tick (mémoire + latence maîtrisées).
 *
 * Phase 2 : handler EXTRACT (détection MIME + extraction texte, par lots). Les autres
 * types (CLASSIFY, RULES, AI_REVIEW…) arrivent aux phases suivantes ; un type sans handler
 * est marqué CANCELLED (jamais de boucle).
 *
 * Découpé par responsabilité — voir le dossier `runner/` : `reglages.ts` (bornes, lots, pool),
 * `passage.ts` (passage borné, prise d'un job, aiguillage, échec), `extraction.ts` (EXTRACT, OCR, FACTS,
 * VISION — ce qui lit le fichier stocké), `revue-ia.ts` (RULES, SIMULATE, AI_REVIEW et suites — ce qui
 * dépend d'un modèle configuré). Un fournisseur n'est importé que d'un seul fichier (cliquet des fuites).
 */

export { runDueRegulatoryJobs, runRegulatoryJob } from "./runner/passage";
