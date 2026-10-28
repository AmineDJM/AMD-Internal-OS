/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE COFFRE — LA PORTE PURE (données sensibles, refonte R6 / V2-E).
 *
 * Importable PARTOUT, navigateur compris : le catalogue des natures (IBAN, RIB, NIN, salaire…),
 * les colonnes sensibles et la politique de lecture — des règles, aucune clé, aucun chiffrement.
 * `frontiere.test.ts` vérifie que cette porte et ce qu'elle réexporte restent purs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Les natures : normaliser, masquer, libeller ──────────────────────────────────────────────
export * from "./domaine/natures";

// ── Les colonnes sensibles des fiches (Employee, CompanyContact, CompanyLegalIdentity) ───────
export {
  LIBELLE_MODELE, MODELES_SENSIBLES, champSensible, champsNonSaisis,
  masqueDepuisClair, masquerSensibles,
  type ModeleSensible,
} from "./domaine/champs";

// ── Qui peut lire quoi (un modèle d'IA, jamais) ─────────────────────────────────────────────

// ── Le port du dépôt (types seulement) ───────────────────────────────────────────────────────
export type { RefTitulaire } from "./domaine/depot";
