/**
 * PORTE PURE du module `acces-bases` (lots D1-D5, décision 0057) — le catalogue des bases et la règle de l'accès par
 * base. Ne réexporte que `domaine/` : importable partout, navigateur compris.
 */
export { CATALOGUE_BASES } from "./domaine/catalogue.genere";
export { LIBELLE_NIVEAU_BASE, baseDe, estBase, enVigueur, niveauPour } from "./domaine/regle";
export type { NiveauBase, Sensibilite } from "./domaine/types";
