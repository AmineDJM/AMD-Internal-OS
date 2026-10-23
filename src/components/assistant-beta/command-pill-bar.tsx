"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Folder, CheckSquare, Users, RotateCcw } from "lucide-react";

export interface CommandPillBarProps {
  onSendMessage: (message: string, moduleFilter?: string) => void;
  onReset?: () => void;
  isLoading: boolean;
}

export function CommandPillBar({ onSendMessage, onReset, isLoading }: CommandPillBarProps) {
  const [input, setInput] = useState("");
  const [selectedModule, setSelectedModule] = useState<string>("TOUS");
  const inputRef = useRef<HTMLInputElement>(null);

  const modules = [
    { id: "TOUS", label: "Tous", icon: Sparkles },
    { id: "REGULATORY", label: "Réglementaire", icon: Folder },
    { id: "WORKSPACE", label: "Tâches", icon: CheckSquare },
    { id: "DIRECTORIES", label: "Annuaire", icon: Users },
  ];

  const suggestions = [
    "Quel est le statut du dossier d'enregistrement Biocare ?",
    "Crée une tâche urgente pour finaliser le module 3",
    "Qui sont les collaborateurs de l'équipe ?",
    "Écris un email résumant les effectifs",
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const texte = input.trim();
    if (!texte || isLoading) return;
    onSendMessage(texte, selectedModule === "TOUS" ? undefined : selectedModule);
    setInput("");
  };

  const handleSuggestionClick = (sug: string) => {
    if (isLoading) return;
    onSendMessage(sug, selectedModule === "TOUS" ? undefined : selectedModule);
  };

  return (
    <div className="relative z-20 mx-auto w-full max-w-4xl space-y-2.5">
      {/* Suggestions rapides (pills Apple-style) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        <span className="text-[11px] font-semibold text-zinc-500/80 dark:text-zinc-400/80 flex items-center gap-1 pl-1 shrink-0">
          <Sparkles className="h-3 w-3 text-amber-500" /> Suggestions :
        </span>
        {suggestions.map((sug, i) => (
          <button
            key={i}
            type="button"
            onClick={() => handleSuggestionClick(sug)}
            disabled={isLoading}
            className="shrink-0 rounded-full border border-white/60 bg-white/60 px-3 py-1 text-xs font-medium text-zinc-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/90 hover:shadow disabled:opacity-50 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {sug}
          </button>
        ))}
      </div>

      {/* Barre de commande flottante en verre */}
      <form
        onSubmit={handleSubmit}
        data-glass="true"
        className="flex flex-col gap-2 rounded-3xl border border-white/60 bg-white/80 p-2 shadow-2xl backdrop-blur-2xl transition-all dark:border-white/10 dark:bg-zinc-950/80"
      >
        {/* Filtres de modules */}
        <div className="flex items-center justify-between gap-1 px-2 pt-1 border-b border-zinc-200/50 pb-2 dark:border-zinc-800/50">
          <div className="flex items-center gap-1">
            {modules.map((m) => {
              const Icon = m.icon;
              const isActive = selectedModule === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedModule(m.id)}
                  className={`inline-flex items-center gap-1 rounded-xl px-2.5 py-1 text-[11px] font-semibold transition-all ${
                    isActive
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-zinc-600 hover:bg-zinc-100/70 dark:text-zinc-400 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  {m.label}
                </button>
              );
            })}
          </div>

          {onReset && (
            <button
              type="button"
              onClick={onReset}
              title="Nouvelle conversation"
              className="inline-flex items-center gap-1 rounded-xl px-2 py-1 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:bg-zinc-800/50"
            >
              <RotateCcw className="h-3 w-3" /> Réinitialiser
            </button>
          )}
        </div>

        {/* Ligne d'entrée de texte */}
        <div className="flex items-center gap-2 px-2 pb-1">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            placeholder="Posez une question, demandez une tâche, ou analysez les dossiers..."
            className="flex-1 bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />

          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-md shadow-blue-500/25 transition-all hover:bg-blue-700 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
