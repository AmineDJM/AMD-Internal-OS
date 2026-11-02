/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE ASSISTANT IA — LA PORTE DES BANCS ET DE L'E2E (`scripts/e2e/`, décision 0026).
 *
 * Le FAUX MODÈLE et son branchement, pour jouer un vrai tour (le fil, les outils, les droits) sans appel de modèle :
 * c'est la règle de la suite E2E. Jamais importée par le code de production — le faux modèle ne sert qu'aux tests
 * (AGENTS.md).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { remplacerModelesPourTests } from "./infra/generer";
export { modeleFactice } from "./infra/testing/modele-factice";

// ── Le banc d'audit permanent (lot Q1, décision 0050) : personas, attaques, tâches, verdicts, semis.
export {
  COMPTE_JOUE, nomComplet, PERSONNES, TITULAIRES, type PersonaCle,
} from "./infra/testing/audit/personas";
export { ATTAQUES, CATEGORIES_ATTAQUE, type Attaque } from "./infra/testing/audit/attaques";
export { CATEGORIES_TACHE, TACHES, type ObjetAttendu, type Tache } from "./infra/testing/audit/taches";
export { jugerTache } from "./infra/testing/audit/taches/juger";
export {
  affirmeFait, agregatsDe, finitParUneQuestion, fuites, noterMail, salutationFausse, temoinsInterdits, type Fuite, type NoteMail, type Temoin,
} from "./infra/testing/audit/verdicts";
export { pieceDe, retirerAudit, semerAudit, sessionDe, type SemisAudit } from "./infra/testing/audit/semis";
export { ecouter, installerEspion, relever, type Lecture } from "./infra/testing/audit/espion";
