/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE RECETTES — LA PORTE PURE (J10, décision 0028). Importable partout, navigateur compris : elle ne réexporte que
 * `domaine/` — processus et circuits, contenu d'une recette, extraction, états (rien n'est appris en silence), plan
 * tiré d'une recette et ses écarts, correspondance d'une demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { LIBELLE_PROCESSUS, PROCESSUS, decrireCircuit, estProcessus, processusExclusPar, type Processus } from "./domaine/processus";
export { jours, montantLisible, pourcent, signatureContenu, type ContenuRecette, type EtapeRecette } from "./domaine/contenu";
export {
  extraireRecette, extraireRecetteForme, extraireRecetteTravail, formeDuPlan, motifMontrable, seuilRond,
  type DossierObserve, type EtapeDefinie, type EvenementDossier, type TravailReussi,
} from "./domaine/extraction";
export {
  LIBELLE_STATUT_RECETTE, LIBELLE_STATUT_VERSION, SEUIL_OCCURRENCES_DEFAUT, decisionExtraction, estResponsable,
  type StatutRecette, type StatutVersion,
} from "./domaine/etats";
export { delaiCite, ecartsALaDemande, ecartsAuPlan, montantCite, phraseValidation, planDeLaRecette, signaturePlan, type PlanRecette } from "./domaine/plan";
export { correspondance } from "./domaine/correspondance";
