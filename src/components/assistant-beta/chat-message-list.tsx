"use client";

import React, { useRef, useEffect } from "react";
import { Bot, User, Sparkles, Loader2, Wrench } from "lucide-react";
import { ActionConfirmationCard } from "./action-confirmation-card";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  outilsAppeles?: string[];
  intent?: {
    id: string;
    kind: string;
    title: string;
    summary?: string;
    fields?: { label: string; value: string }[];
    status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
    resultLink?: string;
    resultMessage?: string;
  } | null;
  createdAt?: string;
}

export interface ChatMessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onConfirmIntent: (intentId: string) => Promise<{ ok: boolean; message?: string; link?: string; error?: string }>;
}

export function ChatMessageList({ messages, isLoading, onConfirmIntent }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 scrollbar-thin">
      {messages.length === 0 && (
        <div className="my-auto flex flex-col items-center justify-center text-center py-16">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/60 bg-white/70 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/70">
            <Sparkles className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Assistant IA — Adventum Pharma
          </h3>
          <p className="mt-1 max-w-md text-xs text-zinc-600 dark:text-zinc-400">
            Interrogez les dossiers AMM, vérifiez le catalogue de produits, planifiez des tâches
            sous validation humaine, ou rédigez des synthèses exécutives.
          </p>
        </div>
      )}

      {messages.map((m) => {
        const isUser = m.role === "user";
        return (
          <div
            key={m.id}
            className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
          >
            {/* Avatar */}
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-sm ${
                isUser
                  ? "bg-blue-600 text-white"
                  : "border border-white/60 bg-white/80 text-zinc-800 backdrop-blur-md dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200"
              }`}
            >
              {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
            </div>

            {/* Bulle de message */}
            <div className={`flex max-w-[85%] sm:max-w-[75%] flex-col ${isUser ? "items-end" : "items-start"}`}>
              {/* Trace des outils si appelés */}
              {!isUser && m.outilsAppeles && m.outilsAppeles.length > 0 && (
                <div className="mb-1.5 flex items-center gap-1 rounded-lg border border-white/50 bg-white/60 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 shadow-xs backdrop-blur-md dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-400">
                  <Wrench className="h-2.5 w-2.5 text-blue-500" />
                  <span>Outils exécutés : {m.outilsAppeles.join(", ")}</span>
                </div>
              )}

              <div
                data-glass="true"
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-md transition-all ${
                  isUser
                    ? "rounded-tr-xs bg-blue-600/90 text-white shadow-blue-500/10 backdrop-blur-md"
                    : "rounded-tl-xs border border-white/60 bg-white/85 text-zinc-800 shadow-zinc-900/5 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/85 dark:text-zinc-200"
                }`}
              >
                <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.content}</div>

                {/* Carte de confirmation intégrée si intention présente */}
                {!isUser && m.intent && (
                  <div className="mt-3">
                    <ActionConfirmationCard
                      intentId={m.intent.id}
                      kind={m.intent.kind}
                      title={m.intent.title}
                      summary={m.intent.summary}
                      fields={m.intent.fields}
                      initialStatus={m.intent.status}
                      resultLink={m.intent.resultLink}
                      resultMessage={m.intent.resultMessage}
                      onConfirm={onConfirmIntent}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Indicateur de génération en cours */}
      {isLoading && (
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/60 bg-white/80 text-zinc-800 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200">
            <Bot className="h-4 w-4" />
          </div>
          <div
            data-glass="true"
            className="flex items-center gap-2 rounded-2xl rounded-tl-xs border border-white/60 bg-white/85 px-4 py-3 text-xs font-medium text-zinc-600 shadow-md backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/85 dark:text-zinc-300"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600 dark:text-blue-400" />
            <span>MiMo analyse la demande et compile la réponse...</span>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
