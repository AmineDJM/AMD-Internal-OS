/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE GRAPHE DE L'ENTREPRISE — LA PORTE PURE (J9, décision 0021). Importable partout, navigateur compris : elle ne réexporte
 * que `domaine/` — les nœuds et arêtes datées, la translittération arabe/latin, la résolution d'entités, le parcours
 * borné, les faits bitemporels et la règle « chaque chiffre porte sa source ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  LIBELLE_TYPE_NOEUD, RELATIONS, TYPES_NOEUD, cleArete, estTypeNoeud, lireRef, phraseRelation, ref, texteProvenance, typeDe, valideA,
  type AreteDatee, type Provenance, type TypeNoeud,
} from "./domaine/noeuds";
export { contientArabe, squelette, translitterer } from "./domaine/translitteration";
export {
  SEUILS_RESOLUTION, distance, forme, identifiantDe, indexer, motsCompares, noterCandidat, resoudreDans, sigle, trancher,
  type CandidatEntite, type CandidatNote, type IndexEntites, type PreuveResolution, type Resolution, type VerdictResolution,
} from "./domaine/resolution";
export {
  ARETES_MAX, NOEUDS_PAR_SAUT_MAX, PROFONDEUR_MAX, cheminVers, noeudsRendus, parcourir,
  type OptionsParcours, type PortsParcours, type ResultatParcours,
} from "./domaine/parcours";
export { etatA, fermeture, histoire, tenuA, vraiA, type EtatALaDate, type FaitDate, type ValeurALaDate } from "./domaine/faits-dates";
export { chiffresSansSource, compterChiffres } from "./domaine/sources";
