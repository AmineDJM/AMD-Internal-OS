"use client";

import React, { useRef, useEffect } from "react";
import { User, Loader2, Wrench } from "lucide-react";
import { ActionConfirmationCard } from "./action-confirmation-card";

function FormattedMessage({ content, isUser }: { content: string; isUser: boolean }) {
  const lines = content.split("\n");

  return (
    <div className="space-y-1.5 [overflow-wrap:anywhere]">
      {lines.map((line, lineIdx) => {
        if (!line.trim()) {
          return <div key={lineIdx} className="h-1.5" />;
        }

        const isBullet = /^\s*[-•*]\s+/.test(line);
        const cleanLine = isBullet ? line.replace(/^\s*[-•*]\s+/, "") : line;

        // Parse inline **bold** and `code`
        const parts: { type: "text" | "bold" | "code"; val: string }[] = [];
        const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        let lastIdx = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(cleanLine)) !== null) {
          if (match.index > lastIdx) {
            parts.push({ type: "text", val: cleanLine.substring(lastIdx, match.index) });
          }
          const token = match[0];
          if (token.startsWith("**") && token.endsWith("**")) {
            parts.push({ type: "bold", val: token.slice(2, -2) });
          } else if (token.startsWith("`") && token.endsWith("`")) {
            parts.push({ type: "code", val: token.slice(1, -1) });
          }
          lastIdx = regex.lastIndex;
        }

        if (lastIdx < cleanLine.length) {
          parts.push({ type: "text", val: cleanLine.substring(lastIdx) });
        }

        const renderedLine = parts.map((part, pIdx) => {
          if (part.type === "bold") {
            return (
              <strong
                key={pIdx}
                className={
                  isUser
                    ? "font-semibold text-white"
                    : "font-semibold text-slate-900 dark:text-zinc-100"
                }
              >
                {part.val}
              </strong>
            );
          }
          if (part.type === "code") {
            return (
              <code
                key={pIdx}
                className={
                  isUser
                    ? "rounded bg-slate-800 px-1 py-0.5 text-xs font-mono text-slate-100"
                    : "rounded bg-slate-100 px-1 py-0.5 text-xs font-mono text-slate-800 dark:bg-zinc-800 dark:text-zinc-200"
                }
              >
                {part.val}
              </code>
            );
          }
          return <React.Fragment key={pIdx}>{part.val}</React.Fragment>;
        });

        if (isBullet) {
          return (
            <div key={lineIdx} className="flex items-start gap-2 pl-1">
              <span className={isUser ? "text-slate-300" : "text-slate-400 dark:text-zinc-500"}>•</span>
              <span className="flex-1">{renderedLine}</span>
            </div>
          );
        }

        return <div key={lineIdx}>{renderedLine}</div>;
      })}
    </div>
  );
}

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
        return (
          <div
            key={m.id}
            className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
          >
            {/* Avatar sobre */}
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold shadow-2xs ${
                isUser
                  ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-slate-200 bg-white text-slate-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {isUser ? <User className="h-3.5 w-3.5" /> : "AB"}
            </div>

            {/* Bulle de message à haute lisibilité */}
            <div className={`flex max-w-[88%] sm:max-w-[78%] flex-col ${isUser ? "items-end" : "items-start"}`}>
              {/* Trace des outils si appelés */}
              {!isUser && m.outilsAppeles && m.outilsAppeles.length > 0 && (
                <div className="mb-1.5 flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                  <Wrench className="h-2.5 w-2.5 text-slate-500" />
                  <span>Sources consultées : {m.outilsAppeles.join(", ")}</span>
                </div>
              )}

              <div
                data-glass="true"
                className={`rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed transition-all ${
                  isUser
                    ? "rounded-tr-xs bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900"
                    : "rounded-tl-xs border border-slate-200/90 bg-white/95 text-slate-900 shadow-2xs backdrop-blur-2xl dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-100"
                }`}
              >
                <FormattedMessage content={m.content} isUser={isUser} />

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

      {/* Indicateur de traitement épuré */}
      {isLoading && (
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 shadow-2xs dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300">
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
