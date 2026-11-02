/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE BIBLIOTHÈQUE — LA PORTE PURE (J1).
 *
 * Importable partout, navigateur compris : elle ne réexporte que `domaine/` (aucune base, aucun Node).
 * L'écran de recherche y lit les libellés (formats, sources, endroits) et le type des extraits.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { FAMILLES, NOMS_FAMILLES, lienDe, type Famille } from "./domaine/familles";
export { FORMATS, NOMS_FORMATS, type Format } from "./domaine/format";
export { LIBELLES_SOURCES, SOURCES, LIMITE_DEFAUT, LIMITE_MAX, type Filtres, type Source } from "./domaine/requete";
export { extraitAPlat, type Segment } from "./domaine/extrait";
export { exclusionPourModele, RAISONS_EXCLUSION_MODELE, type RaisonExclusionModele } from "./domaine/politique";
export type { Voie } from "./domaine/classement";
