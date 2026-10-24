"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { Sparkles, Folder, Package, ShieldCheck, ArrowRight, X, Bot, CheckCircle2 } from "lucide-react";

export function AssistantWelcomeDialog() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Ne s'affiche qu'à la première connexion (ou si l'utilisateur ne l'a pas encore vu)
    const seen = localStorage.getItem("amd_brain_welcome_seen");
    if (!seen) {
      // Léger délai pour une apparition fluide après le chargement de l'interface
      const timer = setTimeout(() => setIsOpen(true), 600);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleClose = () => {
    localStorage.setItem("amd_brain_welcome_seen", "true");
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 select-text animate-in fade-in duration-300">
      {/* Arrière-plan assombri avec flou doux */}
      <div
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-md transition-opacity"
        onClick={handleClose}
      />

      {/* Boîte de dialogue Apple Glassmorphism */}
      <div className="relative z-10 w-full max-w-2xl overflow-hidden rounded-3xl border border-white/60 bg-white/90 p-6 sm:p-8 shadow-2xl backdrop-blur-2xl transition-all dark:border-white/10 dark:bg-zinc-950/90 dark:text-zinc-100">
        {/* Lueur d'ambiance Apple subtle derrière le header */}
        <div className="absolute -top-24 -left-24 h-56 w-56 rounded-full bg-blue-500/20 blur-3xl pointer-events-none" />
        <div className="absolute -top-24 -right-24 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl pointer-events-none" />

        {/* Bouton de fermeture */}
        <button
          onClick={handleClose}
          className="absolute top-5 right-5 rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          title="Fermer"
        >
          <X className="h-5 w-5" />
        </button>

        {/* En-tête avec badge et icône */}
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/25">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
              <Sparkles className="h-3 w-3" />
              <span>Nouveau sur Adventum Pharma</span>
            </div>
            <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              Bienvenue sur Adventum Brain 👋
            </h2>
            <p className="mt-1 text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
              Votre assistant d'entreprise intelligent est désormais connecté en direct à votre ERP.
            </p>
          </div>
        </div>

        {/* Grille des 4 super-pouvoirs de l'assistant */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Carte 1 */}
          <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/60 p-3.5 transition hover:bg-zinc-50 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/60">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                <Folder className="h-4 w-4" />
              </div>
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Dossiers Réglementaires AMM</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Consultez les dossiers d'enregistrement, statuts d'instruction, échéances et variations en temps réel.
            </p>
          </div>

          {/* Carte 2 */}
          <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/60 p-3.5 transition hover:bg-zinc-50 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/60">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                <Package className="h-4 w-4" />
              </div>
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Catalogue Produits & DCI</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Recherchez instantanément parmi 109 références pharmaceutiques, formes galéniques et dosages.
            </p>
          </div>

          {/* Carte 3 */}
          <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/60 p-3.5 transition hover:bg-zinc-50 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/60">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
                <CheckCircle2 className="h-4 w-4" />
              </div>
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Actions Sécurisées (HITL)</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Créez des tâches ou diffusez des messages d'équipe : aucune modification n'est faite sans votre confirmation.
            </p>
          </div>

          {/* Carte 4 */}
          <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/60 p-3.5 transition hover:bg-zinc-50 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/60">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Sécurité & Confidentialité</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Filtrage strict des données sensibles (salaires masqués) et respect absolu de vos droits RBAC.
            </p>
          </div>
        </div>

        {/* Exemples de questions suggérées */}
        <div className="mt-4 rounded-xl border border-blue-200/60 bg-blue-50/50 p-3 dark:border-blue-900/40 dark:bg-blue-950/20">
          <div className="text-[11px] font-semibold text-blue-900 dark:text-blue-300 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-blue-600" />
            Exemples de questions à lui poser :
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
            <span className="rounded-lg bg-white/80 px-2 py-0.5 shadow-2xs border border-zinc-200/50 dark:bg-zinc-900 dark:border-zinc-800">
              « Quel est le statut du dossier Biocare ? »
            </span>
            <span className="rounded-lg bg-white/80 px-2 py-0.5 shadow-2xs border border-zinc-200/50 dark:bg-zinc-900 dark:border-zinc-800">
              « Crée une tâche urgente pour finaliser le module 3 »
            </span>
            <span className="rounded-lg bg-white/80 px-2 py-0.5 shadow-2xs border border-zinc-200/50 dark:bg-zinc-900 dark:border-zinc-800">
              « Combien de produits sont au catalogue ? »
            </span>
          </div>
        </div>

        {/* Boutons d'action */}
        <div className="mt-6 flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5">
          <button
            onClick={handleClose}
            className="w-full sm:w-auto rounded-xl border border-zinc-300/80 bg-white px-4 py-2 text-xs font-semibold text-zinc-700 shadow-xs transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Continuer vers mon espace
          </button>
          <Link
            href="/assistant"
            onClick={handleClose}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-blue-500/20 transition hover:bg-blue-500 active:scale-95"
          >
            Découvrir l'Assistant IA
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
