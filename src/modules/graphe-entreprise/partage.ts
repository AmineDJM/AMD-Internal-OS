/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE GRAPHE DE L'ENTREPRISE — LA PORTE PURE (J9, décision 0021). Importable partout, navigateur compris : elle ne réexporte
 * que `domaine/` — les nœuds et arêtes datées, la translittération arabe/latin, la résolution d'entités, le parcours
 * borné, les faits bitemporels et la règle « chaque chiffre porte sa source ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  LIBELLE_TYPE_NOEUD, TYPES_NOEUD, estTypeNoeud, lireRef, phraseRelation, texteProvenance, typeDe, type Provenance, type TypeNoeud,
} from "./domaine/noeuds";
export { indexer, resoudreDans, type Resolution } from "./domaine/resolution";
export { fermeture } from "./domaine/faits-dates";
export { chiffresSansSource, compterChiffres } from "./domaine/sources";
