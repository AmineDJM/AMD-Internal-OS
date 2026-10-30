/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE GRAPHE DE L'ENTREPRISE — LA PORTE SERVEUR (J9, décision 0021) : le graphe de l'entreprise et les faits datés.
 *
 * Aucune table à lui : les nœuds sont les fiches canoniques (Personne, Organisation, Product, RegulatoryProduct,
 * demandes Ad & Pro, congrès, Piece), les arêtes sont lues où elles sont écrites (EntityLink, PieceLien, FaitConfirme,
 * EntityMention, clés métier). Les droits jugent chaque nœud AVANT le parcours. Lit `referentiels` (normalisation des
 * noms) et `bibliotheque` (la règle d'ouverture d'une pièce, la règle de lecture d'un fait).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";
export { perimetreDe, typesOuverts, type Perimetre } from "./infra/perimetre";
export { aretesDe } from "./infra/aretes";
export { decrire, type NoeudDecrit } from "./infra/noeuds";
export { indexEntites, oublierIndex, resoudreEntite } from "./infra/index-entites";
export { explorerRelations, type EtapeRendue, type Exploration, type NoeudAtteint } from "./infra/explorer";
export { dOuVient, etatALaDate, faitsDeLAttribut, type EtatEntite, type Provenance360, type RelationALaDate, type ValeurSourcee } from "./infra/faits";
