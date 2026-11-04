/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANCIEN MOTEUR D'ADAM, MASQUÉ (lot I6, décision 0070 ; audit AU3 §4, étape 4).
 *
 * La Direction (04/11/2026) : « Je veux vraiment que ce soit la même architecture, le même truc. C'est juste les accès qui
 * changent » ; et pour ce lot : « ne supprime pas du code évidemment ! juste masque au pire ou en comment ».
 *
 * Toutes les entrées d'un tour passent désormais par le moteur unique (`jouerTour`, `src/modules/assistant-ia`) : écrit,
 * voix, dictée, Bureau d'Adam, appel vocal, Adventum Brain, relance (nudge), routines, missions. L'ancienne boucle
 * (`lib/assistant/boucle/*` : `runAssistant`, `runAssistantStream`) et ses routes (`/api/assistant/*`) ne sont PAS
 * supprimées : elles sont MASQUÉES derrière ce drapeau, et reviennent telles quelles avec lui.
 *
 *   ADAM_ANCIEN_MOTEUR=1   → l'ancien moteur et ses routes reviennent (Bureau, appel global, dictée, Brain, relance) ;
 *                            `AssistantThread` redevient écrit.
 *   (absent, défaut)       → moteur unique ; routes de l'ancienne voix et de la dictée répondent 410 ; `AssistantThread`
 *                            est GELÉ EN LECTURE (l'historique reste consultable, `/adam/bureau`).
 *
 * LA SEULE PORTE vers la boucle : `ancienneBoucle()`. Hors de `src/lib/assistant/`, aucun fichier n'importe
 * `runAssistant` / `runAssistantStream` ni `lib/assistant/boucle/*` : il les obtient d'ici, et `null` sans le drapeau.
 * Tenu par `src/platform/moteur-unique.test.ts` (test d'architecture).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le nom du drapeau — écrit une fois. */
export const DRAPEAU_ANCIEN_MOTEUR = "ADAM_ANCIEN_MOTEUR";

/** L'ancien moteur est-il remis ? Défaut : NON (moteur unique). Seule la valeur exacte « 1 » le remet. */
export function ancienMoteurActif(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[DRAPEAU_ANCIEN_MOTEUR] ?? "").trim() === "1";
}

/** Ce que dit une route de l'ancien moteur quand il est masqué. */
export const MESSAGE_ANCIEN_MOTEUR_MASQUE =
  "Cette entrée de l'ancien Adam est mise de côté : Adam a désormais un seul moteur. Parlez-lui depuis Adventum IA (/assistant) — écrit, vocal ou conversation vocale.";

/** La réponse d'une route masquée : 410 (Gone), le motif dit, et où aller. */
export function reponseAncienMoteurMasque(): Response {
  return Response.json({ error: MESSAGE_ANCIEN_MOTEUR_MASQUE, reasonCode: "ANCIEN_MOTEUR_MASQUE", aller: "/assistant" }, { status: 410 });
}

/**
 * LA BOUCLE DE L'ANCIEN MOTEUR — chargée seulement sous le drapeau (import dynamique : sans lui, le module n'est même
 * pas évalué par l'appelant). `null` = masquée : l'appelant joue le tour par le moteur unique.
 */
export async function ancienneBoucle(env: NodeJS.ProcessEnv = process.env): Promise<typeof import("./boucle/entree") | null> {
  if (!ancienMoteurActif(env)) return null;
  // Le puits de télémétrie que la porte `lib/assistant.ts` charge d'ordinaire en tête — chargé ici aussi.
  await import("@/platform/ia/telemetry/usage-sink");
  return import("./boucle/entree");
}
