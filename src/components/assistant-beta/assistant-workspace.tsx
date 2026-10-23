"use client";

import React, { useState } from "react";
import Image from "next/image";
import { LuminescentCursor } from "./luminescent-cursor";
import { ChatMessageList, type ChatMessage } from "./chat-message-list";
import { CommandPillBar } from "./command-pill-bar";
import { envoyerMessageBeta, confirmerActionBeta } from "@/app/(app)/assistant/beta/actions";
import type { KpiData } from "./kpi-glass-strip";

export interface AssistantWorkspaceProps {
  initialKpiData?: KpiData;
  userName?: string;
  userRole?: string;
}

const INITIAL_GREETING = `Bonjour 👋\n\nBienvenue sur **Adventum Brain**. Je suis votre assistant interne, à votre disposition pour vous accompagner dans vos tâches.\n\nComment puis-je vous aider aujourd'hui ?`;

export function AssistantWorkspace({ initialKpiData, userName, userRole }: AssistantWorkspaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome-1",
      role: "assistant",
      content: INITIAL_GREETING,
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSendMessage = async (text: string, moduleFilter?: string) => {
    const userMsg: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const historiqueFormat = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await envoyerMessageBeta(text, moduleFilter, historiqueFormat);

      if (res.ok) {
        const assistantMsg: ChatMessage = {
          id: res.messageId,
          role: "assistant",
          content: res.content,
          outilsAppeles: res.outilsAppeles,
          intent: res.intent || null,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: res.error || "Une erreur est survenue lors du traitement.",
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    } catch (e: any) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: `Erreur de communication : ${e.message}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmIntent = async (intentId: string) => {
    return confirmerActionBeta(intentId);
  };

  const handleReset = () => {
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: INITIAL_GREETING,
      },
    ]);
  };

  return (
    <div className="relative h-full w-full flex-1 overflow-hidden bg-slate-900 select-text flex flex-col">
      {/* 1. Curseur luminescent avec spring physics */}
      <LuminescentCursor />

      {/* 2. Arrière-plan animé Makoto Shinkai haute résolution avec flou accentué de 20% */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <Image
          src="/images/assistant-bg-shinkai.jpg"
          alt="Peaceful Anime Mountain Lake Background"
          fill
          priority
          sizes="100vw"
          className="object-cover object-center scale-110 filter blur-[10px] transition-transform duration-1000"
        />
        {/* Voile atmosphérique équilibré pour une lisibilité parfaite des cartes de verre */}
        <div className="absolute inset-0 bg-slate-950/25 backdrop-blur-[2px] dark:bg-black/40" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/40 via-transparent to-slate-950/20" />
      </div>

      {/* 3. Conteneur principal ERP & Chat en verre dépoli Apple (Plein écran & épuré) */}
      <div className="relative z-10 flex h-full w-full flex-1 flex-col p-2 sm:p-4 lg:p-6 overflow-hidden">
        {/* Espace central de conversation en verre translucide */}
        <div
          data-glass="true"
          className="relative mx-auto flex h-full w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/75 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/70"
        >
          <ChatMessageList
            messages={messages}
            isLoading={isLoading}
            onConfirmIntent={handleConfirmIntent}
          />

          {/* Barre de commande flottante au bas du chat */}
          <div className="p-3 pt-0 sm:p-4 sm:pt-0">
            <CommandPillBar
              onSendMessage={handleSendMessage}
              onReset={handleReset}
              isLoading={isLoading}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
