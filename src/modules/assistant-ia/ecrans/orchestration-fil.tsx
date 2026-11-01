"use client";

import React from "react";
import { Clock, Hourglass, MessageCircleQuestion } from "lucide-react";
import type { OrchestrationFil } from "../domaine/conversation/agenda";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORCHESTRATEUR DANS LE FIL ÉCRIT (lot O1, décision 0046) — ce que l'écran montre pendant qu'un travail tourne :
 * la QUESTION utile de l'agenda (une à la fois, ses choix d'un toucher, ou une réponse écrite), le résultat TENU tant
 * qu'elle attend sa réponse (« affiché après ta réponse » — ou tout de suite d'un geste), et l'avancement réel.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export function QuestionAgenda({ question, onRepondre, desactive }: {
  question: NonNullable<OrchestrationFil["question"]>;
  onRepondre: (texte: string) => void;
  desactive?: boolean;
}) {
  return (
    <div className="flex items-start gap-3" data-testid="question-agenda">
      <div className="hidden h-7 w-7 shrink-0 sm:block" />
      <div className="w-full rounded-2xl rounded-tl-md border border-violet-200 bg-violet-50/80 px-3.5 py-3 text-[15px] text-slate-800 sm:max-w-[85%] sm:text-[14px] dark:border-violet-900 dark:bg-violet-950/40 dark:text-zinc-100">
        <p className="flex items-start gap-1.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
          <MessageCircleQuestion className="mt-px h-3.5 w-3.5 shrink-0" /> Pendant que je travaille — pour que le résultat te serve mieux
        </p>
        <p className="mt-1.5 font-medium">{question.texte}</p>
        {question.choix.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {question.choix.map((c) => (
              <button key={c} type="button" disabled={desactive} onClick={() => onRepondre(c)} data-testid="choix-agenda"
                className="min-h-11 rounded-full border border-violet-300 bg-white px-4 text-[14px] font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-200">
                {c}
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-500 dark:text-zinc-400">Tu peux aussi répondre en écrivant, ou demander autre chose : la conversation continue.</p>
      </div>
    </div>
  );
}

export function ResultatTenu({ onVoir }: { onVoir: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-600 dark:text-zinc-300" data-testid="resultat-tenu">
      <Hourglass className="h-3.5 w-3.5 shrink-0" />
      <span>Résultat prêt — affiché après ta réponse à la question ci-dessous.</span>
      <button type="button" onClick={onVoir} className="min-h-11 rounded-full px-3 text-[13px] font-medium text-[#2c59a7] underline-offset-2 hover:underline">Voir maintenant</button>
    </div>
  );
}

export function AvancementTravail({ texte }: { texte: string }) {
  return (
    <p className="mt-2 flex items-start gap-1 text-[11px] text-slate-500 dark:text-zinc-400" data-testid="avancement-travail">
      <Clock className="mt-px h-3 w-3 shrink-0" /> Où ça en est : {texte}
    </p>
  );
}
