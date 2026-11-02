/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE CONSOMMATION (Consumption Intelligence) — LA SEULE PORTE SERVEUR.
 *
 * Hors de `src/modules/consommation/`, on importe CE fichier (ou un écran de `ecrans/` depuis
 * `src/app/`), jamais `domaine/` ni `infra/` : tenu par ESLint (`no-restricted-imports`) et par
 * `src/modules/frontieres.test.ts`. Ce qui n'est pas exporté ici est un détail d'implémentation,
 * libre de changer sans prévenir personne.
 *
 * Serveur seulement : la porte réexporte `infra/` (Prisma, xlsx). Un composant client du module
 * lit `../domaine/*` (pur) et appelle les actions serveur.
 *
 * Tables possédées : `ConsommationImport`, `ConsommationLigne`, `ConsommationMemoire`,
 * `AffiniteConfig`. Actions serveur : `./actions.ts` (clé `consommation-actions`, déclarée dans
 * `src/lib/actions/parc.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Commandes (écritures) ─────────────────────────────────────────────────────────────────
export {
  importerConsommation, confirmerCorrespondance, ignorerLigne, validerImport, annulerImport,
  type ResultatAnalyse,
} from "./infra/imports";

// ── Requêtes (lectures) ───────────────────────────────────────────────────────────────────
export { listerImports, lireImport, lignesDeLImport, groupesDeLImport, referentielsDeRevue, produitsEtConfigsAffinite, nomsEtablissements,
  STATUTS_LIGNE, type StatutLigne } from "./infra/requetes";
export { lignesDuMarche, affinitesEtablissements } from "./infra/affinite";

// ── Règles pures utiles aux autres modules ──────────────────────────────────────────────────
export { calculerAffinites, lireConfig, PERIODE_LABELS } from "./domaine/affinite";
