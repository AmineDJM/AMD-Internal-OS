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

/** L'accueil, au prénom de la personne : l'assistant travaille pour ELLE, avec SES droits. */
function accueil(userName?: string): string {
  const prenom = (userName ?? "").trim().split(/\s+/)[0];
  return `Bonjour${prenom ? ` ${prenom}` : ""} 👋\n\nJe suis votre assistant interne. Je lis ce que vos accès vous permettent de voir, et je prépare tâches et messages — rien ne part sans votre confirmation.\n\nComment puis-je vous aider ?`;
}

export function AssistantWorkspace({ userName }: AssistantWorkspaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome-1",
      role: "assistant",
      content: accueil(userName),
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSendMessage = async (text: string) => {
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

      const res = await envoyerMessageBeta(text, undefined, historiqueFormat);

      if (res.ok) {
        const assistantMsg: ChatMessage = {
          id: res.messageId,
          role: "assistant",
          content: res.content,
          blocs: res.blocs,
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
    } catch {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: "La connexion a été interrompue. Réessayez dans un instant.",
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
        content: accueil(userName),
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

      {/* 3. Conteneur principal — plein écran sur téléphone (chaque pixel compte), verre dépoli au-delà. */}
      <div className="relative z-10 flex h-full w-full flex-1 flex-col overflow-hidden sm:p-4 lg:p-6">
        <div
          data-glass="true"
          className="relative mx-auto flex h-full w-full max-w-5xl flex-1 flex-col overflow-hidden bg-white/80 backdrop-blur-2xl sm:rounded-3xl sm:border sm:border-white/60 sm:bg-white/75 sm:shadow-2xl dark:bg-zinc-950/75 sm:dark:border-white/10 sm:dark:bg-zinc-950/70"
        >
          <ChatMessageList
            messages={messages}
            isLoading={isLoading}
            onConfirmIntent={handleConfirmIntent}
          />

          {/* Barre de saisie — au-dessus de la barre système du téléphone (zone sûre). */}
          <div className="px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 sm:p-4 sm:pt-0">
            <CommandPillBar
              onSendMessage={handleSendMessage}
              onReset={handleReset}
              isLoading={isLoading}
              showSuggestions={messages.length <= 1}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
