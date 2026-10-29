"use client";

import React, { useRef, useEffect } from "react";
import { User, Loader2, Wrench, Clock, Mic, AlertTriangle } from "lucide-react";
import { ActionConfirmationCard } from "./action-confirmation-card";
import { MarkdownMessage } from "./markdown-message";
import { MemoireProposeeCard } from "./memoire-proposee-card";
import { PiecesDuMessage } from "./pieces-jointes";
import { BulleVocale } from "./bulle-vocale";
import { PHRASE_VOCAL_COUPE, type AudioDuTour, type LecturePiece, type VocalDuTour } from "@/lib/agent/lecture/regles";
import type { MemoireProposee } from "@/lib/agent/memoire-ui";
import { WorkspaceBlocks } from "@/platform/ia/ecrans/blocks";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** L'UI générative (R5) : composants prouvés par les outils du tour, dessinés par `WorkspaceBlocks`. */
  blocs?: WorkspaceBlock[];
  /** Les pièces jointes d'un message de la personne (dans son Drive). */
  pieces?: { id: string; nom: string }[];
  /** Ce que la lecture de chaque pièce a donné (lue, partielle, refusée…) — dit sous la pièce. */
  lectures?: LecturePiece[] | null;
  /** Un message VOCAL : le lecteur, la durée, la transcription dessous. `local` : l'enregistrement pas encore envoyé. */
  vocal?: (Omit<VocalDuTour, "id"> & { id: string | null; local?: string | null }) | null;
  /** La réponse VOCALE de l'assistant (option « réponse vocale »). */
  audio?: AudioDuTour | null;
  /** Une mémoire PROPOSÉE par l'assistant — retenue seulement au geste de la personne. */
  memoireProposee?: MemoireProposee | null;
  outilsAppeles?: string[];
  /**
   * Le fil gardé (27/10) : « attente » = message en file (répondu après les précédents) ;
   * « redaction » = réponse qui s'écrit sous les yeux ; « echec » = tour qui n'a pas abouti.
   */
  etat?: "attente" | "redaction" | "echec";
  intent?: {
    id: string;
    kind: string;
    title: string;
    summary?: string;
    fields?: { label: string; value: string }[];
    warnings?: string[];
    confirmText?: string;
    /** Le libellé du bouton quand « Confirmer » ne dit pas le geste. */
    libelleBouton?: string;
    status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
    resultLink?: string;
    resultMessage?: string;
  } | null;
  createdAt?: string;
}

export interface ChatMessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onConfirmIntent: (intentId: string, confirmTyped?: string) => Promise<{ ok: boolean; message?: string; link?: string; error?: string }>;
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
              <div className="flex max-w-[85%] flex-col items-end gap-1.5 sm:max-w-[75%]">
                {m.vocal && (
                  <div className="flex max-w-full flex-col gap-1.5 rounded-2xl rounded-tr-md bg-slate-900 px-3 py-2.5 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900">
                    <BulleVocale id={m.vocal.id} local={m.vocal.local ?? null} dureeS={m.vocal.dureeS} sombre libelle="votre message vocal" />
                    {m.vocal.etat === "TRANSCRIT" && m.vocal.transcription && (
                      <p className="whitespace-pre-wrap border-t border-white/15 pt-1.5 text-[13px] leading-snug text-white/85 [overflow-wrap:anywhere] dark:border-zinc-900/15 dark:text-zinc-700">
                        {m.vocal.transcription}
                      </p>
                    )}
                    {m.vocal.etat === "TRANSCRIPTION" && (
                      <span className="flex items-center gap-1 text-[11px] text-white/70 dark:text-zinc-600">
                        {m.vocal.id ? <><Loader2 className="h-3 w-3 animate-spin" /> Transcription…</> : <><Mic className="h-3 w-3" /> Envoi du vocal…</>}
                      </span>
                    )}
                    {m.vocal.etat === "ECHEC" && (
                      <span className="flex items-start gap-1 text-[11px] text-amber-200 dark:text-amber-700">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> {m.vocal.erreur ?? "Transcription impossible."}
                      </span>
                    )}
                  </div>
                )}
                {m.content && (
                  <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-slate-900 px-3.5 py-2.5 text-[15px] leading-relaxed text-white shadow-xs [overflow-wrap:anywhere] sm:text-[14px] dark:bg-zinc-100 dark:text-zinc-900">
                    {m.content}
                  </div>
                )}
                {m.pieces && m.pieces.length > 0 && <PiecesDuMessage pieces={m.pieces} lectures={m.lectures} />}
                {m.etat === "attente" && (
                  <span className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-zinc-400">
                    <Clock className="h-3 w-3" /> En file — traité après le message précédent
                  </span>
                )}
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
                {m.etat === "redaction" && (
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-zinc-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {m.content ? "Rédaction…" : m.outilsAppeles?.length ? "Je consulte vos données…" : "Je réfléchis…"}
                  </div>
                )}
                {m.audio && (m.audio.id ? (
                  <div className="mb-2 flex flex-col gap-1">
                    <BulleVocale id={m.audio.id} dureeS={m.audio.dureeS} libelle="la réponse vocale" />
                    {m.audio.coupe && <span className="text-[11px] text-slate-500 dark:text-zinc-400">{PHRASE_VOCAL_COUPE}</span>}
                  </div>
                ) : m.audio.erreur ? (
                  <p className="mb-2 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-px h-3 w-3 shrink-0" /> Réponse vocale indisponible : {m.audio.erreur}</p>
                ) : null)}
                {m.content && <MarkdownMessage texte={m.content} />}
                {m.etat === "echec" && !m.content && <p className="text-sm text-red-600 dark:text-red-400">La demande n&apos;a pas abouti.</p>}
                {/* L'UI GÉNÉRATIVE : les composants que le serveur a prouvés, sous le texte. */}
                {m.blocs && m.blocs.length > 0 && (
                  <div className="mt-3 min-w-0">
                    <WorkspaceBlocks composition={{ source: "assistant-ia", blocks: m.blocs }} />
                  </div>
                )}
                {m.memoireProposee && (
                  <div className="mt-3">
                    <MemoireProposeeCard memoire={m.memoireProposee} />
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
                      warnings={m.intent.warnings}
                      confirmText={m.intent.confirmText}
                      libelleBouton={m.intent.libelleBouton}
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
