import { aiConfigured, askClaudeCheap } from "@/lib/ai";
import {
  createThread, appendExchange, filsGeles, distillationDue, countMessages, recentMessages, getMemory, saveMemory,
} from "@/lib/assistant-memory";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRITURE D'UN ÉCHANGE DANS LA MÉMOIRE D'ADAM — un module serveur, PAS une action serveur.
 *
 * ── POURQUOI CE FICHIER EXISTE (§118.153) ─────────────────────────────────────────────────
 *
 * `rememberExchange` vivait dans `actions/assistant-actions.ts`, un fichier « use server » : tout
 * ce qu'il exporte est un point d'entrée public, appelable par n'importe quelle session qui
 * connaît l'identifiant de l'action. Or elle reçoit l'identité de la personne EN ARGUMENT
 * (`userId`) au lieu de la lire dans la session : un appel forgé pouvait écrire un échange dans
 * la mémoire d'un collègue, et déclencher à ses frais la distillation par un modèle. La dérivation
 * des contrats le savait déjà — elle la refusait au chemin générique d'Adam (« une action qui
 * reçoit son auteur au lieu de le lire dans la session ») —, mais un refus au chemin générique
 * ne ferme pas le point d'entrée lui-même.
 *
 * Masquer Adam à tous sauf au Super Admin a exigé de garder CHAQUE porte d'Adam ; celle-ci ne
 * pouvait pas l'être, parce que ses appelants légitimes (la route de flux, le tour vocal) lui
 * passent justement l'identité qu'ils ont lue dans LEUR session. Elle cesse donc d'être une
 * porte : ses trois appelants (deux routes gardées et l'action de conversation) l'importent
 * d'ici, et plus rien ne l'expose au navigateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * DISTILLATION DE LA MÉMOIRE — la « grande mémoire » de l'assistant.
 *
 * Tous les ~12 messages, on relit les échanges RÉCENTS DE CETTE PERSONNE (helpers scopés) et
 * on réécrit une note durable : ses sujets, ses dossiers, ses habitudes, ses préférences de
 * formulation. Cette note est réinjectée au prochain tour via `personalContext`.
 * Appel économique et épisodique ; toute erreur est silencieuse (la mémoire est un confort,
 * jamais un point de rupture du chat).
 */
async function maybeDistillMemory(userId: string): Promise<void> {
  try {
    if (!aiConfigured()) return;
    if (!(await distillationDue(userId))) return;
    const [msgs, previous] = await Promise.all([recentMessages(userId, 60), getMemory(userId)]);
    if (msgs.length === 0) return;
    const transcript = msgs
      .map((m) => `${m.role === "user" ? "Personne" : "Assistant"} : ${m.content.slice(0, 800)}`)
      .join("\n");
    const res = await askClaudeCheap(
      `${previous ? `NOTE ACTUELLE (à mettre à jour, pas à jeter) :\n${previous}\n\n` : ""}` +
      `ÉCHANGES RÉCENTS :\n${transcript}\n\n` +
      `Rédige la note de mémoire à jour (12 lignes maximum, en français, sans Markdown).`,
      {
        system:
          "Tu tiens la mémoire durable d'un assistant interne, pour UNE seule personne. " +
          "Retiens ce qui reste vrai dans le temps : son périmètre, ses dossiers et produits suivis, " +
          "ses interlocuteurs habituels, ses préférences de travail et de formulation, ses échéances récurrentes. " +
          "Ignore le bavardage et tout ce qui est déjà périmé. Écris des phrases courtes et factuelles.",
        maxTokens: 500,
      },
    );
    if (!res.ok || !res.text) return;
    await saveMemory(userId, res.text, await countMessages(userId));
  } catch (e) {
    console.error("[assistant] distillation de la mémoire impossible (non bloquant)", e);
  }
}

/**
 * DÉCOUPAGE DE LA MÉMOIRE EN ÉPISODES — la seconde moitié de la mémoire, et la plus utile.
 *
 * ── CE QU'ELLE FAIT QUE LA DISTILLATION NE FAIT PAS ──────────────────────────────────────
 *
 * `maybeDistillMemory` tient UNE note par personne : ce qui reste vrai dans le temps. Elle
 * écrase la précédente à chaque passage, donc elle ne sait pas dire « en mars, on avait décidé
 * X, puis en juin on est revenu dessus ». L'épisode, lui, est daté, borné par deux messages, et
 * sa fidélité décroît avec l'âge sans jamais perdre un montant, une référence ni une correction.
 *
 * Les deux coexistent parce qu'elles répondent à deux questions différentes — « qui est cette
 * personne » et « que s'est-il passé, et quand ». Fusionner les deux redonnerait une note qui
 * grossit sans fin, c'est-à-dire le comportement qu'on cherche à éviter.
 *
 * Non bloquant, comme la distillation : la mémoire ne fait jamais échouer un tour réussi.
 */
async function maybeCutEpisode(userId: string, threadId: string): Promise<void> {
  try {
    const { noterEpisode, vieillirMemoire } = await import("@/platform/in-process/missions/memory");
    const r = await noterEpisode(userId, threadId);
    if (!r.episodeId) return;

    console.info(
      `[assistant] épisode ${r.episodeId} — ${r.tours} tours, `
      + `${r.jetonsAvant} → ${r.jetonsApres} jetons estimés`,
    );

    // ET, PUISQU'ON EST ICI, ON FAIT VIEILLIR LA MÉMOIRE DE CETTE PERSONNE.
    //
    // Le battement le fait aussi, mais par une file BORNÉE à dix comptes par passage, et
    // seulement tant que quelqu'un sollicite l'application. Or la personne dont la mémoire
    // grossit le plus vite est précisément celle qui parle le plus — et c'est elle qui paiera
    // le contexte le plus lourd au prochain tour. La compresser au moment où elle gagne un
    // souvenir, plutôt qu'en attendant un créneau, est le geste évident.
    //
    // Ce n'est PAS un coût par tour : on n'arrive ici qu'une fois par tranche d'épisode, et si
    // rien n'a vieilli la file est vide et aucun modèle n'est appelé.
    await vieillirMemoire(new Date(), { userId });
  } catch (e) {
    console.error("[assistant] découpage en épisode impossible (non bloquant)", e);
  }
}

/**
 * Mémorise un échange dans le fil de CETTE personne et renvoie l'identifiant du fil.
 *
 * Un fil inconnu — ou appartenant à quelqu'un d'autre — n'est jamais écrit : on en ouvre
 * simplement un nouveau. C'est la seule écriture de mémoire de l'assistant, partagée par
 * l'action serveur et la route de flux, pour que la règle de cloisonnement n'existe qu'en
 * un seul endroit.
 */
export async function rememberExchange(
  userId: string, threadId: string | null, userMessage: string, reply: string,
  /**
   * CE QU'ADAM A CONSTRUIT à ce tour (`WorkspaceComposition[]`). Facultatif : la voix et les
   * chemins sans espace de travail n'en produisent pas, et un tour sans blocs n'en écrit pas.
   */
  workspace?: unknown,
): Promise<string | null> {
  // I6 (décision 0070) : `AssistantThread` est gelé en lecture — l'échange n'y est plus écrit (ni distillé d'ici).
  if (filsGeles()) return threadId;
  try {
    let tid = threadId;
    if (tid) {
      const ok = await appendExchange(userId, tid, userMessage, reply, workspace);
      if (!ok) tid = null; // fil inconnu ou n'appartenant pas au demandeur → on repart proprement
    }
    if (!tid) {
      tid = await createThread(userId, userMessage);
      await appendExchange(userId, tid, userMessage, reply, workspace);
    }
    await maybeDistillMemory(userId);
    await maybeCutEpisode(userId, tid);
    return tid;
  } catch (e) {
    console.error("[assistant] mémorisation impossible (non bloquant)", e);
    return threadId;
  }
}
