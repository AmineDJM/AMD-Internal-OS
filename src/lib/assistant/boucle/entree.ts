/**
 * LES DEUX PORTES D'ENTRÉE DU MOTEUR — `runAssistant` et `runAssistantStream` ouvrent un tour
 * mesuré autour des boucles (`boucle/tour.ts`, `boucle/flux.ts`).
 */

import type { CurrentUser } from "@/lib/assistant/coeur/erp";
import {
  withTurn, markPreview, markFinal, logTurn, setTurnContext, summarize, type TurnRoute, type TurnContext,
} from "@/lib/models/telemetry";
import { ADAM_PROMPT_VERSION } from "@/lib/assistant/prompt-version";
import type { ChatTurn, AssistantResult } from "@/lib/assistant/coeur/contrat-actions";
import { runAssistantImpl } from "@/lib/assistant/boucle/tour";
import type { AssistantStreamEvent } from "@/lib/assistant/boucle/sources";
import { runAssistantStreamImpl } from "@/lib/assistant/boucle/flux";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX PORTES D'ENTRÉE DU MOTEUR — et le tour mesuré qu'elles ouvrent.
 *
 * Le corps du moteur n'a pas bougé : ces enveloppes ne font qu'ouvrir un TOUR autour de lui,
 * pour que chaque appel de modèle, chaque outil et chaque milliseconde se rattachent à quelque
 * chose de nommé. Sans cela, « Adam est lent » resterait une impression.
 *
 * LA VOIE VIENT DE L'ORIGINE, pas d'une devinette :
 *   • `text`  — demande écrite : elle part DIRECTEMENT sur l'orchestrateur, sans passer par le
 *               temps réel (c'est la règle §2, et la ventilation par rôle le prouve) ;
 *   • `voice` — on est ici parce que la session temps réel a DÉLÉGUÉ (niveau C). Un tour vocal
 *               est déjà ouvert : `withTurn` le REJOINT au lieu d'en créer un second, sinon les
 *               appels de l'orchestrateur seraient invisibles depuis le tour vocal — c'est-à-dire
 *               qu'on cacherait la preuve même qu'un C fait travailler l'orchestrateur ;
 *   • `nudge` — proactif, personne n'attend devant l'écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const routeOf = (origin: "text" | "voice" | "nudge" | undefined): TurnRoute =>
  origin === "voice" ? "voice-deep" : origin === "nudge" ? "background" : "text";

export interface AssistantRunOptions {
  model?: string;
  personalContext?: string | null;
  origin?: "text" | "voice" | "nudge";
  /** De quoi signer le tour (fil, usage) — la personne est toujours ajoutée depuis `user`. */
  turnContext?: TurnContext;
}

export function runAssistant(
  user: CurrentUser,
  history: ChatTurn[],
  opts: AssistantRunOptions = {},
): Promise<AssistantResult> {
  return withTurn(routeOf(opts.origin), async (trace) => {
    setTurnContext({ userId: user.id, feature: opts.origin === "nudge" ? "nudge" : "assistant", promptVersion: ADAM_PROMPT_VERSION, ...(opts.turnContext ?? {}) });
    let result: AssistantResult | null = null;
    try {
      result = await runAssistantImpl(user, history, opts);
      return result;
    } finally {
      markFinal();
      // Le résumé du tour VOYAGE avec le résultat : c'est lui que la route persiste (jetons, coût).
      if (result) result.turn = summarize(trace);
      logTurn(trace);
    }
  });
}

export function runAssistantStream(
  user: CurrentUser,
  history: ChatTurn[],
  emit: (e: AssistantStreamEvent) => void,
  opts: AssistantRunOptions = {},
): Promise<AssistantResult> {
  return withTurn(routeOf(opts.origin), async (trace) => {
    setTurnContext({ userId: user.id, feature: opts.origin === "nudge" ? "nudge" : "assistant", promptVersion: ADAM_PROMPT_VERSION, ...(opts.turnContext ?? {}) });
    let result: AssistantResult | null = null;
    try {
      // LE PREMIER SIGNE DE VIE est marqué au premier événement réellement diffusé — pas à
      // l'entrée de la fonction. C'est la mesure qui compte : un tour qui met six secondes mais
      // montre quelque chose à 400 ms est vécu comme rapide.
      result = await runAssistantStreamImpl(user, history, (e) => { markPreview(); emit(e); }, opts);
      return result;
    } finally {
      markFinal();
      if (result) result.turn = summarize(trace);
      logTurn(trace);
    }
  });
}
