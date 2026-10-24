"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight, X, Bot, Check, Zap, Shield, FileText } from "lucide-react";

export function AssistantWelcomeDialog() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Clé de version de la mise à jour pour ne l'afficher qu'une fois par utilisateur
    const seenUpdate = localStorage.getItem("amd_update_assistant_live_v1");
    if (!seenUpdate) {
      // Déclenchement fluide dès la connexion
      const timer = setTimeout(() => setIsOpen(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem("amd_update_assistant_live_v1", "true");
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 select-text animate-in fade-in zoom-in-95 duration-200">
      {/* Arrière-plan flouté sombre */}
      <div
        className="fixed inset-0 bg-slate-950/65 backdrop-blur-md transition-opacity"
        onClick={handleDismiss}
      />

      {/* Carte modale "Mise à jour Système" en verre dépoli Apple */}
      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-3xl border border-white/60 bg-white/95 p-6 sm:p-7 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/95 dark:text-zinc-100">
        {/* Lueur subtile en arrière-plan */}
        <div className="absolute -top-20 -left-20 h-48 w-48 rounded-full bg-blue-500/20 blur-3xl pointer-events-none" />
        <div className="absolute -top-20 -right-20 h-48 w-48 rounded-full bg-emerald-500/15 blur-3xl pointer-events-none" />

        {/* Bouton fermeture */}
        <button
          onClick={handleDismiss}
          className="absolute top-5 right-5 rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          title="Fermer"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Badge "Mise à jour en direct" */}
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] font-bold tracking-wide uppercase text-emerald-600 dark:text-emerald-400">
            Mise à jour Système • En Direct (Live)
          </span>
        </div>

        {/* Titre & accroche */}
        <div className="mt-3 flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-emerald-500 text-white shadow-md shadow-blue-500/20">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              L'Assistant IA est désormais en ligne !
            </h2>
            <p className="mt-1 text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
              Découvrez **Adventum Brain**, votre nouveau copilote interne connecté en direct aux opérations d'Adventum Pharma.
            </p>
          </div>
        </div>

        {/* Contenu de la mise à jour (Points forts) */}
        <div className="mt-5 space-y-2.5 rounded-2xl border border-zinc-200/70 bg-zinc-50/70 p-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/50">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Ce que cette mise à jour vous permet de faire :
          </div>

          <div className="space-y-2 text-xs text-zinc-700 dark:text-zinc-300">
            <div className="flex items-start gap-2.5">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 mt-0.5">
                <FileText className="h-3 w-3" />
              </div>
              <div>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">Interroger les données métier</span> : dossiers réglementaires AMM, fiches produits et disponibilités catalogue en langage naturel.
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300 mt-0.5">
                <Zap className="h-3 w-3" />
              </div>
              <div>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">Préparer des actions en 1 clic</span> : demandez la création d'une tâche urgente ou un message interne avec cartes de confirmation interactives.
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-300 mt-0.5">
                <Shield className="h-3 w-3" />
              </div>
              <div>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">Sécurité & Confidentialité</span> : filtrage des informations confidentielles et respect strict de vos privilèges d'accès.
              </div>
            </div>
          </div>
        </div>

        {/* Emplacement dans l'ERP */}
        <div className="mt-3.5 flex items-center gap-2 rounded-xl border border-blue-200/50 bg-blue-50/50 px-3 py-2 text-[11px] text-blue-800 dark:border-blue-900/30 dark:bg-blue-950/25 dark:text-blue-300">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
          <span>
            Accessible à tout moment depuis le menu latéral gauche : <strong>Pilotage → Assistant IA</strong>.
          </span>
        </div>

        {/* Boutons d'action */}
        <div className="mt-6 flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5">
          <button
            onClick={handleDismiss}
            className="w-full sm:w-auto rounded-xl border border-zinc-300/80 bg-white px-4 py-2 text-xs font-semibold text-zinc-700 shadow-xs transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Compris, continuer
          </button>
          <Link
            href="/assistant"
            onClick={handleDismiss}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-blue-500/20 transition hover:bg-blue-500 active:scale-95"
          >
            Tester l'Assistant IA en direct
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
