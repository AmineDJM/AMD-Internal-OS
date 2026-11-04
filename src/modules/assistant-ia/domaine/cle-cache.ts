/**
 * LA CLÉ DE CACHE DU FOURNISSEUR — UNE PAR PERSONNE, POUR TOUTES LES ENTRÉES (lot I6, décision 0070 ; AU3 §6).
 *
 * Le cache d'invite d'OpenAI (`prompt_cache_key`) regroupe les appels qui partagent un PRÉFIXE stable. AU3 mesurait 48 %
 * seulement d'entrée lue en cache : l'ancien moteur avait sa propre clé (aucune, en fait), les routines et les missions
 * aucune. Désormais conversation écrite, voix, Bureau, Brain, relance, routines et missions de la personne portent la MÊME
 * clé : le préfixe commun (identité, règles, consignes générales, la personne) se relit en cache d'une entrée à l'autre.
 *
 * PUR : aucune donnée de la personne n'y entre hormis son identifiant interne (pas de nom, pas de rôle — la clé ne doit
 * pas changer quand un réglage change, sinon le cache se perd à chaque modification de la console).
 */
export const PREFIXE_CLE_CACHE = "assistant-ia:";

export function cleCacheDeLaPersonne(userId: string): string {
  return `${PREFIXE_CLE_CACHE}${userId}`;
}
