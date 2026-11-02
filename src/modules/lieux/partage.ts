/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE LIEUX — LA PORTE PURE (référentiel du socle, refonte V2-D).
 *
 * Importable PARTOUT, navigateur compris : elle ne réexporte que `domaine/`, qui n'importe ni
 * base, ni Next, ni Node. Un composant client, un autre `domaine/` ou une page l'importent ici ;
 * l'écriture en base passe par `./api`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Lire un lieu écrit à la main : « Alger », « ALGER CENTRE », « 16 – Alger »… ────────────────
export { normaliserLieu, normaliserWilaya, type RaisonRejet } from "./domaine/normaliser";

// ── Rattacher une fiche à sa wilaya (règle pure) ─────────────────────────────────────────────
export { COLONNES_LIEU, MODELES_LIEU, estAmbigu, estEnAlgerie, rattacherFiche, type ModeleLieu } from "./domaine/rattachement";

// ── Regrouper par wilaya (lu sur `wilayaCode`, pas sur le texte) ─────────────────────────────
export { regrouperParWilaya, type ParWilaya } from "./domaine/par-wilaya";
