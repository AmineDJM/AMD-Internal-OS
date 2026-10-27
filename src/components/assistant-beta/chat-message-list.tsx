"use client";

import React, { useRef, useEffect } from "react";
import { User, Loader2, Wrench } from "lucide-react";
import { ActionConfirmationCard } from "./action-confirmation-card";
import { MarkdownMessage } from "./markdown-message";
import { WorkspaceBlocks } from "@/components/chief/workspace/blocks";
import type { WorkspaceBlock } from "@/lib/assistant/workspace/protocol";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** L'UI générative (R5) : composants prouvés par les outils du tour, dessinés par `WorkspaceBlocks`. */
  blocs?: WorkspaceBlock[];
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
    <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4 scrollbar-thin sm:px-4 sm:py-6">
      {messages.length === 0 && (
        <div className="my-auto flex flex-col items-center justify-center text-center py-16">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200">AB</span>
          </div>
          <h3 className="mt-3 text-sm font-semibold tracking-tight text-slate-900 dark:text-zinc-100">
            Adventum Brain
          </h3>
          <p className="mt-1 max-w-md text-xs text-slate-500 dark:text-zinc-400">
            Module de consultation et d&apos;assistance pour les dossiers réglementaires, le catalogue et les tâches internes.
          </p>
        </div>
      )}

      {messages.map((m) => {
        const isUser = m.role === "user";
        if (isUser) {
          return (
            <div key={m.id} className="flex items-start justify-end gap-3">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-slate-900 px-3.5 py-2.5 text-[15px] leading-relaxed text-white shadow-xs [overflow-wrap:anywhere] sm:max-w-[75%] sm:text-[14px] dark:bg-zinc-100 dark:text-zinc-900">
                {m.content}
              </div>
              <div className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white shadow-2xs sm:flex dark:bg-zinc-100 dark:text-zinc-900">
                <User className="h-3.5 w-3.5" />
              </div>
            </div>
          );
        }
        return (
          <div key={m.id} className="flex items-start gap-3">
            {/* Sur téléphone, pas d'avatar : la réponse prend toute la largeur. */}
            <div className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 shadow-2xs sm:flex dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300">
              AB
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2 sm:max-w-[85%]">
              {m.outilsAppeles && m.outilsAppeles.length > 0 && (
                <div className="flex max-w-full items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                  <Wrench className="h-2.5 w-2.5 shrink-0 text-slate-500" />
                  <span className="truncate">{m.outilsAppeles.join(" · ")}</span>
                </div>
              )}
              <div
                data-glass="true"
                className="w-full rounded-2xl rounded-tl-md border border-slate-200/90 bg-white/95 px-3.5 py-3 text-[15px] leading-relaxed text-slate-800 shadow-2xs backdrop-blur-2xl sm:px-4 sm:text-[14px] dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-100"
              >
                <MarkdownMessage texte={m.content} />
                {/* L'UI GÉNÉRATIVE : les composants que le serveur a prouvés, sous le texte. */}
                {m.blocs && m.blocs.length > 0 && (
                  <div className="mt-3 min-w-0">
                    <WorkspaceBlocks composition={{ source: "assistant-ia", blocks: m.blocs }} />
                  </div>
                )}
                {m.intent && (
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

      {/* Indicateur de traitement épuré */}
      {isLoading && (
        <div className="flex items-start gap-3">
          <div className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 shadow-2xs sm:flex dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300">
            AB
          </div>
          <div
            data-glass="true"
            className="flex items-center gap-2 rounded-2xl rounded-tl-xs border border-slate-200/90 bg-white/95 px-3.5 py-2.5 text-xs font-medium text-slate-600 shadow-2xs backdrop-blur-2xl dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-300"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-600 dark:text-slate-400" />
            <span>Consultation en cours...</span>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
