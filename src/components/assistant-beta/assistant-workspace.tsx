"use client";

import React, { useState } from "react";
import Image from "next/image";
import { LuminescentCursor } from "./luminescent-cursor";
import { KpiGlassStrip, type KpiData } from "./kpi-glass-strip";
import { ChatMessageList, type ChatMessage } from "./chat-message-list";
import { CommandPillBar } from "./command-pill-bar";
import { envoyerMessageBeta, confirmerActionBeta } from "@/app/(app)/assistant/beta/actions";

export interface AssistantWorkspaceProps {
  initialKpiData: KpiData;
}

export function AssistantWorkspace({ initialKpiData }: AssistantWorkspaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome-1",
      role: "assistant",
      content: `Salam alaykoum ${initialKpiData.userName} ! Bienvenue sur le nouvel Assistant IA d'Adventum Pharma.\n\nJe suis configuré pour vous assister dans vos opérations quotidiennes (dossiers réglementaires AMM, vérification de catalogue, préparation de tâches sécurisées, ou synthèses d'activité). Comment puis-je vous aider ?`,
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
        content: `Nouvelle conversation initialisée. Que souhaitez-vous accomplir ?`,
      },
    ]);
  };

  return (
    <div className="relative min-h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-slate-900 select-text">
      {/* 1. Curseur luminescent avec spring physics */}
      <LuminescentCursor />

      {/* 2. Arrière-plan animé Makoto Shinkai haute résolution */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <Image
          src="/images/assistant-bg-shinkai.jpg"
          alt="Peaceful Anime Mountain Lake Background"
          fill
          priority
          sizes="100vw"
          className="object-cover object-center scale-105 transition-transform duration-1000"
        />
        {/* Voile atmosphérique pour lisibilité 100% des textes & chiffres */}
        <div className="absolute inset-0 bg-slate-950/20 backdrop-brightness-[0.92] dark:bg-black/35" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/40 via-transparent to-slate-950/20" />
      </div>

      {/* 3. Conteneur principal ERP & Chat en verre dépoli Apple */}
      <div className="relative z-10 flex h-[calc(100vh-3.5rem)] w-full flex-col justify-between p-3 sm:p-5">
        {/* Bandeau KPI supérieur */}
        <KpiGlassStrip initialData={initialKpiData} />

        {/* Espace central de conversation en verre translucide */}
        <div
          data-glass="true"
          className="relative mx-auto my-3 flex h-full w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/75 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/70"
        >
          <ChatMessageList
            messages={messages}
            isLoading={isLoading}
            onConfirmIntent={handleConfirmIntent}
          />

          {/* Barre de commande flottante au bas du chat */}
          <div className="p-3 pt-0">
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
