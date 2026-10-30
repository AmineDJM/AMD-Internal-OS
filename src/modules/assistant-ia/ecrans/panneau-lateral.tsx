"use client";

import React, { useEffect } from "react";
import { ArrowLeft, X } from "lucide-react";

/**
 * LE PANNEAU LATÉRAL DE L'ASSISTANT IA — la coque commune des panneaux « Routines » et « Travaux » : voile, feuille
 * (en bas sur téléphone, à droite ailleurs), en-tête avec retour éventuel et fermeture, Échap qui ferme, pied facultatif.
 */
export function PanneauLateral({ etiquette, titre, icone, onRetour, libelleRetour, onFermer, largeur = "sm:w-[460px]", pied, children }: {
  etiquette: string;
  titre: string;
  icone: React.ReactNode;
  /** Présent : un bouton « retour » remplace l'icône (une vue de détail est ouverte). */
  onRetour?: () => void;
  libelleRetour?: string;
  onFermer: () => void;
  largeur?: string;
  pied?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const fermer = (e: KeyboardEvent) => { if (e.key === "Escape") onFermer(); };
    window.addEventListener("keydown", fermer);
    return () => window.removeEventListener("keydown", fermer);
  }, [onFermer]);
  const boutonIcone = "flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end" role="dialog" aria-modal="true" aria-label={etiquette}>
      <button type="button" aria-label="Fermer" onClick={onFermer} className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]" />
      <div className={`relative flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:max-h-none ${largeur} sm:rounded-none dark:bg-zinc-950`}>
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 sm:hidden" />
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
          {onRetour ? (
            <button type="button" onClick={onRetour} aria-label={libelleRetour ?? "Retour"} className={boutonIcone}><ArrowLeft className="h-4 w-4" /></button>
          ) : icone}
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-slate-900 dark:text-zinc-100">{titre}</h2>
          <button type="button" onClick={onFermer} aria-label="Fermer" className={boutonIcone}><X className="h-4 w-4" /></button>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">{children}</div>
        {pied && (
          <footer className="border-t border-slate-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-[12px] leading-relaxed text-slate-500 dark:border-zinc-800">{pied}</footer>
        )}
      </div>
    </div>
  );
}
