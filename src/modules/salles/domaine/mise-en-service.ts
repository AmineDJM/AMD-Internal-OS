/**
 * LES SALLES SONT MISES DE CÔTÉ (Direction, 03/11/2026 : « il n'y a pas de réservation de la salle »). Lot T3, décision 0051.
 *
 * UN interrupteur, lu à chaque appel : la variable d'environnement `SALLES_EN_SERVICE=1` (Render › Environment) remet tout
 * en service sans une ligne de code — opérations et lecture de l'assistant, capacités génériques, écran `/salles`, actions.
 * Absente (le défaut) : rien n'est offert, l'écran redirige, les actions refusent. Les tables et les migrations restent.
 */
export function sallesEnService(env: Record<string, string | undefined> = process.env): boolean {
  return env.SALLES_EN_SERVICE === "1";
}

/** Le refus des actions quand les salles sont mises de côté. */
export const REFUS_SALLES_HORS_SERVICE = "La réservation de salles n'est pas en service.";

/** La clé du fichier d'actions des salles au contrat (clé historique) — retirée du registre de l'assistant hors service. */
export const CLE_ACTIONS_SALLES = "moyens-generaux-registre-actions";
