/**
 * LA GRILLE TARIFAIRE, VUE DU SOCLE — module PUR (navigateur compris) : les modules métier (l'écran « Consommation »
 * d'Adventum IA) la lisent ici plutôt que dans `src/lib/models/` (frontières, `MODULES.md`). Lot K8, décision 0035.
 */
export {
  dollarsArrondis, dollarsExacts, facturer, GRILLE_RELEVEE_LE, LIBELLE_POSTE, POSTES, tarifDuModele, type Poste,
} from "@/lib/models/tarifs";
