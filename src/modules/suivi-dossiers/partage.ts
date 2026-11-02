/**
 * MODULE SUIVI DE DOSSIERS — LA PORTE PURE (lot T3, décision 0051) : la mise à jour des dossiers depuis un tableau —
 * statuts écrits en français, colonnes reconnues, rapprochement ligne ↔ dossier contrôlé, plan des changements.
 */
export {
  LIBELLE_PRIORITE_DOSSIER, LIBELLE_STATUT_DOSSIER, lireChangementsAppliques, lireStatutDossier, phraseChangement, planDeMiseAJour, replierTexte, reperesColonnes,
  type ChangementApplique, type LigneTableau, type PlanMiseAJour, type PrioriteDossier, type StatutDossier,
} from "./domaine/maj-lot";
