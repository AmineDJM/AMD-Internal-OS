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
