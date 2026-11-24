/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE PILOTAGE — LA PORTE ÉTROITE DES ÉCRIVAINS (comme `bibliotheque/api-inscription.ts`).
 *
 * Une dizaine de mécanismes écrivent dans les signaux datés (Voix du terrain, Produits 360, les fonctions d'IA qui
 * proposent et les gestes qui tranchent). S'ils importaient `api.ts`, chacun tirerait dans son graphe l'instantané des
 * finances et le contrôle des clés. Ici : écrire, et rien d'autre (Prisma + le domaine pur).
 * Réexporte la porte pure : un écrivain construit ses lignes avec les règles du domaine.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";
export {
  ecrireSignaux, ecrireSignauxSansBloquer, noterDecision, noterProposition, type DecisionANoter, type PropositionANoter,
} from "./infra/ecriture";
export { societeDeLaBu, societeDuProduit } from "./infra/dimensions";
