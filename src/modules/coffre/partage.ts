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
  CHAMPS_SENSIBLES, LIBELLE_MODELE, MODELES_SENSIBLES, champSensible, champsDe, champsNonSaisis, classerValeur,
  estModeleSensible, estUnMasque, masqueDepuisClair, masquerSensibles, texteDeColonne,
  type ChampSensible, type Classement, type ModeleSensible,
} from "./domaine/champs";

// ── Qui peut lire quoi (un modèle d'IA, jamais) ─────────────────────────────────────────────
export {
  peutLire, type DecisionLecture, type LecteurCoffre, type MotifAccord, type MotifRefus, type TitulaireCoffre,
  type TitulaireLu, type UsageLecture,
} from "./domaine/politique";

// ── Le port du dépôt (types seulement) ───────────────────────────────────────────────────────
export type { AccesDonneeSensibleJournal, DepotCoffre, DonneeSensibleStockee, RefTitulaire, ResumeDonneeSensible } from "./domaine/depot";
