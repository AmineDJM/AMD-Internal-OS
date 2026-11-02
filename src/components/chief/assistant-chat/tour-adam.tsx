"use client";

/**
 * LA CONVERSATION — un tour d'Adam (l'objet, son geste, la synthèse) et l'avatar.
 */
import { Sparkles, Bot, CheckCircle2 } from "lucide-react";
import { Button } from "./erp";
import type { AssistantActionPayload } from "@/lib/assistant";
import { TurnWorkspaceView } from "@/components/chief/workspace/turn-workspace";
import { composeTurn, isWorkspaceTurn } from "@/lib/assistant/workspace/turn";
import type { Msg } from "./modele";
import { LinkifiedText } from "./texte-lie";
import { ActionCard } from "./carte-action";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN TOUR D'ADAM — l'objet d'abord, son geste dessous, la synthèse ensuite.
 *
 * Ce composant remplace l'empilement historique (pastilles d'outils → prose → blocs → cartes de
 * confirmation détachées) par le rangement décidé dans `lib/assistant/workspace/turn.ts`. Il ne
 * décide rien lui-même : il place ce que le rangement a trié, et il INJECTE les cartes d'action
 * là où elles appartiennent — sous l'objet qu'elles engagent.
 *
 * Le repli sur une bulle de texte reste possible, et c'est voulu : « Il est 15 h » n'est pas un
 * espace de travail, et l'encadrer comme tel ferait chercher un bouton qui n'existe pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function AdamTurn({
  msg, text, onConfirm, onCancel, onConfirmAll, bubble = false,
}: {
  msg: Msg;
  text: string;
  onConfirm: (id: number, index: number, payload: AssistantActionPayload, intentId?: string, confirmTyped?: string) => void;
  onCancel: (id: number, index: number, intentId?: string) => void;
  onConfirmAll: (msg: Msg) => void;
  bubble?: boolean;
}) {
  const proposals = msg.proposals ?? [];
  const states = msg.actionStates ?? [];

  const turn = composeTurn({
    compositions: msg.workspace ?? null,
    proposals: proposals.map((p, i) => ({
      kind: p.payload.kind,
      title: p.title,
      state: (states[i] ?? "pending") as "pending" | "done" | "failed" | "cancelled",
      level: p.level,
    })),
    trace: msg.trace ?? null,
    reply: text,
  });

  const cards = (indexes: number[]) =>
    indexes.map((i) => {
      const p = proposals[i];
      if (!p) return null;
      return (
        <ActionCard
          key={i}
          proposal={p}
          state={states[i] ?? "pending"}
          result={msg.actionResults?.[i]}
          link={msg.actionLinks?.[i]}
          onConfirm={(confirmTyped) => onConfirm(msg.id, i, p.payload, p.intentId, confirmTyped)}
          onCancel={() => onCancel(msg.id, i, p.intentId)}
        />
      );
    });

  // ── LE REPLI VERBAL. Aucun objet à montrer : on rend la phrase, et les éventuelles cartes.
  if (!isWorkspaceTurn(turn)) {
    return (
      <div className="chat-measure space-y-2">
        {text ? (
          bubble ? (
            <div className="min-w-0 whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-secondary px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere] sm:px-4">
              <LinkifiedText text={text} />
            </div>
          ) : (
            <p className="chief-turn-text whitespace-pre-wrap [overflow-wrap:anywhere]"><LinkifiedText text={text} /></p>
          )
        ) : null}
        {cards(proposals.map((_, i) => i))}
      </div>
    );
  }

  return (
    <TurnWorkspaceView
      turn={turn}
      renderProposals={cards}
      renderSynthesis={(t) => <LinkifiedText text={t} />}
      renderBundle={() => (
        // §10 — UNE MISSION COHÉRENTE, UNE CONFIRMATION. Le bandeau se place APRÈS l'objet de
        // tête : on comprend d'abord CE QU'ON confirme, on confirme ensuite.
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-accent/30 px-3 py-2 text-sm" data-testid="turn-bundle">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 basis-40">
            {turn.pending} actions préparées — elles forment une seule mission.
          </span>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => onConfirmAll(msg)}>
            <CheckCircle2 className="h-4 w-4" /> Tout confirmer
          </Button>
        </div>
      )}
    />
  );
}

export function Avatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-purple-500 text-primary-foreground">
      <Bot className="h-4 w-4" />
    </div>
  );
}
