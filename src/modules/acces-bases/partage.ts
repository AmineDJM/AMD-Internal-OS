/**
 * PORTE PURE du module `acces-bases` (lots D1-D5, décision 0057) — le catalogue des bases et la règle de l'accès par
 * base. Ne réexporte que `domaine/` : importable partout, navigateur compris.
 */
export { CATALOGUE_BASES, FICHES_TABLES } from "./domaine/catalogue.genere";
export { LIBELLE_NIVEAU_BASE, MODES_STRICTS, baseDe, baseDuModele, COLONNES_REFERENCE, estBase, enVigueur, estModeStrict, lireRefusBase, niveauPour } from "./domaine/regle";
export type { ModeStrict } from "./domaine/regle";
export type { NiveauBase, Sensibilite } from "./domaine/types";
