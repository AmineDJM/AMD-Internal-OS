"use client";

/**
 * LA CONVERSATION — le PONT avec l'appel vocal global (`CallProvider`) : les tours vocaux et les
 * cartes d'outils reviennent dans le fil, et l'appel démarré depuis une fiche part une seule fois.
 * Un crochet appelé à la même place que le code qu'il remplace : l'ordre des crochets est inchangé.
 * Les setters reçus (stables, issus de `useState`) figurent dans les dépendances : hors du composant,
 * la règle des crochets ne peut plus savoir qu'ils le sont.
 */
import * as React from "react";
import { useCall } from "@/components/layout/call-provider";
import type { VoiceToolUi } from "../realtime-voice";
import type { ProposedAction } from "@/lib/assistant";
import { type ActionState, type Msg, nextId } from "./modele";

type Source = { label: string; href: string; detail?: string };

export function usePontAppel({ setMessages, setSources, setThreadId, refreshThreads, threadId, initialCallRef, realtimeVoice }: {
  setMessages: React.Dispatch<React.SetStateAction<Msg[]>>;
  setSources: React.Dispatch<React.SetStateAction<Source[]>>;
  setThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  refreshThreads: () => Promise<void>;
  threadId: string | null;
  initialCallRef: string | null;
  realtimeVoice: boolean;
}) {
  // ── APPEL VOCAL : le pont avec l'APPEL GLOBAL (CallProvider, monté au layout — l'appel
  //    survit à la navigation ERP). Pendant un appel, le texte tapé entre DANS la session
  //    (réponse parlée) ; les tours vocaux et les cartes d'outils reviennent s'afficher ICI —
  //    voix et texte sont deux modalités de la même conversation.
  const call = useCall();
  const onVoiceTurn = React.useCallback((userText: string, assistantText: string) => {
    setMessages((m) => [
      ...m,
      { id: nextId(), role: "user", content: userText },
      { id: nextId(), role: "assistant", at: Date.now(), content: assistantText },
    ]);
    void refreshThreads();
  }, [refreshThreads, setMessages]);
  const onVoiceToolUi = React.useCallback((ui: VoiceToolUi) => {
    if (ui.sources?.length) {
      setSources((prev) => {
        const merged = [...prev];
        for (const s of ui.sources ?? []) if (!merged.some((x) => x.href === s.href)) merged.unshift(s);
        return merged.slice(0, 30);
      });
    }
    const proposals = (ui.proposals ?? null) as ProposedAction[] | null;
    // Le COMPAGNON VISUEL : les actions à confirmer et les analyses détaillées s'affichent
    // dans le fil pendant que la voix résume — la carte de confirmation reste LA porte.
    if (proposals?.length) {
      setMessages((m) => [...m, {
        id: nextId(), role: "assistant", at: Date.now(),
        content: ui.reply || (proposals.length === 1 ? "Action proposée — à confirmer ci-dessous." : `${proposals.length} actions proposées — à confirmer ci-dessous.`),
        trace: ui.trace,
        proposals,
        actionStates: proposals.map(() => "pending" as ActionState),
        actionResults: proposals.map(() => undefined),
        actionLinks: proposals.map(() => undefined),
      }]);
    } else if (ui.reply && ui.reply.length > 400) {
      // Une analyse déléguée détaillée mérite l'écran ; la voix n'en dit que la synthèse.
      setMessages((m) => [...m, { id: nextId(), role: "assistant", at: Date.now(), content: ui.reply as string, trace: ui.trace }]);
    }
  }, [setMessages, setSources]);

  // Le chat se BRANCHE sur l'appel global tant qu'il est monté (les tours et cartes arrivés
  // pendant une navigation ailleurs sont bufferisés par le provider et rattrapés ici).
  const setBridge = call.setBridge;
  React.useEffect(() => {
    setBridge({ onTurn: onVoiceTurn, onToolUi: onVoiceToolUi, onThreadId: (tid) => setThreadId(tid) });
    return () => setBridge(null);
  }, [setBridge, onVoiceTurn, onVoiceToolUi, setThreadId]);

  // APPEL DEPUIS UNE FICHE : ?call=1&ref=… — l'appel démarre AVEC le dossier en contexte
  // (« Où ça bloque ? » se comprend tout seul). Un seul démarrage, jamais en boucle.
  const callStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (initialCallRef === null || callStartedRef.current || !realtimeVoice) return;
    callStartedRef.current = true;
    call.start({
      threadId,
      screenContext: initialCallRef
        ? `L'utilisateur appelle DEPUIS la fiche « ${initialCallRef} » — « ça », « ce dossier » s'y réfèrent sauf indication contraire.`
        : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCallRef, realtimeVoice]);
  return call;
}
