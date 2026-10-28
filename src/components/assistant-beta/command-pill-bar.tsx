"use client";

import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw } from "lucide-react";

export interface CommandPillBarProps {
  onSendMessage: (message: string) => void;
  onReset?: () => void;
  isLoading: boolean;
  /** Les suggestions ne s'affichent que sur une conversation vide : ensuite, elles gênent. */
  showSuggestions?: boolean;
  /** Les gestes à gauche du champ (pièces jointes, vocal) — posés par l'écran. */
  leading?: React.ReactNode;
  /** Ce qui se pose au-dessus du champ (pièces jointes en attente). */
  above?: React.ReactNode;
  /** Envoi possible sans texte (une pièce jointe seule). */
  canSendEmpty?: boolean;
  /** Envoi suspendu (une pièce jointe est encore en cours d'envoi) — le champ reste utilisable. */
  sendBlocked?: boolean;
  /**
   * Le micro des messages vocaux — à la place du bouton d'envoi tant que le champ est vide, comme
   * dans une messagerie. Il se pose par-dessus la barre pendant l'enregistrement (minuterie, onde).
   */
  vocal?: React.ReactNode;
}

/**
 * LE CHAMP DE SAISIE — pensé pour le pouce d'abord.
 *
 * Un champ qui grandit avec le texte (jusqu'à six lignes), en 16 px sur téléphone (iOS zoome sur
 * un champ plus petit), un bouton d'envoi de 40 px. Entrée envoie sur ordinateur ; sur écran
 * tactile, Entrée va à la ligne et le bouton envoie — comme dans les messageries.
 *
 * Les anciens filtres de module sont retirés : le serveur ne les lisait pas, ils ne filtraient rien.
 */
const SUGGESTIONS = [
  "Quelles sont mes tâches en cours ?",
  "Explique-moi le circuit d'une demande de sponsoring",
  "Prépare une tâche pour demain",
];

export function CommandPillBar({ onSendMessage, onReset, isLoading, showSuggestions = false, leading, above, canSendEmpty = false, sendBlocked = false, vocal }: CommandPillBarProps) {
  const [input, setInput] = useState("");
  const zone = useRef<HTMLTextAreaElement>(null);

  // Le champ grandit avec le texte, puis défile au-delà de six lignes.
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const envoyer = () => {
    const texte = input.trim();
    if (isLoading || sendBlocked || (!texte && !canSendEmpty)) return;
    onSendMessage(texte);
    setInput("");
  };

  const surTouche = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    const tactile = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (tactile) return;
    e.preventDefault();
    envoyer();
  };

  return (
    <div className="relative z-20 mx-auto w-full max-w-4xl space-y-2">
      {showSuggestions && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 no-scrollbar">
          {SUGGESTIONS.map((sug) => (
            <button
              key={sug}
              type="button"
              onClick={() => !isLoading && onSendMessage(sug)}
              disabled={isLoading}
              className="shrink-0 rounded-full border border-slate-200/90 bg-white/90 px-3 py-1.5 text-[13px] font-medium text-slate-700 shadow-2xs transition hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {sug}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); envoyer(); }}
        data-glass="true"
        className="relative rounded-2xl border border-slate-200/90 bg-white/95 p-1.5 shadow-xl backdrop-blur-2xl dark:border-zinc-800 dark:bg-zinc-950/95"
      >
        {above}
        <div className="flex items-end gap-1">
          {leading}
          <textarea
            ref={zone}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={surTouche}
            disabled={isLoading}
            placeholder="Écrivez votre demande…"
            aria-label="Votre message"
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-6 text-slate-900 placeholder:text-slate-400 focus:outline-none sm:text-sm dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              title="Nouvelle conversation"
              aria-label="Nouvelle conversation"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          {(!vocal || input.trim() || canSendEmpty) && (
            <button
              type="submit"
              disabled={isLoading || sendBlocked || (!input.trim() && !canSendEmpty)}
              aria-label="Envoyer"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white shadow-2xs transition hover:bg-slate-800 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
          {vocal && !input.trim() && vocal}
        </div>
      </form>
    </div>
  );
}
