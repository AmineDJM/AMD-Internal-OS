"use client";

import React, { useState, useRef } from "react";
import { Send, SlidersHorizontal, Folder, CheckSquare, Users, RotateCcw } from "lucide-react";

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
    { id: "TOUS", label: "Tous", icon: SlidersHorizontal },
    { id: "REGULATORY", label: "Réglementaire", icon: Folder },
    { id: "WORKSPACE", label: "Tâches", icon: CheckSquare },
    { id: "DIRECTORIES", label: "Annuaire", icon: Users },
  ];

  const suggestions = [
    "Quel est le statut du dossier d'enregistrement Biocare ?",
    "Crée une tâche urgente pour finaliser le module 3",
    "Qui sont les collaborateurs de l'équipe ?",
    "Combien de produits sont au catalogue ?",
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
    <div className="relative z-20 mx-auto w-full max-w-4xl space-y-2">
      {/* Suggestions sobres */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
        <span className="text-[11px] font-medium text-slate-500 pl-1 shrink-0 dark:text-zinc-400">
          Suggestions :
        </span>
        {suggestions.map((sug, i) => (
          <button
            key={i}
            type="button"
            onClick={() => handleSuggestionClick(sug)}
            disabled={isLoading}
            className="shrink-0 rounded-lg border border-slate-200/90 bg-white/90 px-2.5 py-1 text-xs font-medium text-slate-700 shadow-2xs transition hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {sug}
          </button>
        ))}
      </div>

      {/* Barre de commande sobre */}
      <form
        onSubmit={handleSubmit}
        data-glass="true"
        className="flex flex-col gap-2 rounded-2xl border border-slate-200/90 bg-white/95 p-2 shadow-xl backdrop-blur-2xl transition-all dark:border-zinc-800 dark:bg-zinc-950/95"
      >
        {/* Filtres de modules */}
        <div className="flex items-center justify-between gap-1 px-2 pt-1 border-b border-slate-100 pb-2 dark:border-zinc-800">
          <div className="flex items-center gap-1">
            {modules.map((m) => {
              const Icon = m.icon;
              const isActive = selectedModule === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedModule(m.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                    isActive
                      ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
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
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <RotateCcw className="h-3 w-3" /> Réinitialiser
            </button>
          )}
        </div>

        {/* Ligne d'entrée de texte */}
        <div className="flex items-center gap-2 px-2 pb-0.5">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            placeholder="Interroger les dossiers, vérifier un produit ou préparer une tâche..."
            className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />

          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white shadow-2xs transition hover:bg-slate-800 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
