"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowRight, X, FileText, ListChecks, Shield } from "lucide-react";

export function AssistantWelcomeDialog() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const seenUpdate = localStorage.getItem("amd_update_assistant_live_v1");
    if (!seenUpdate) {
      const timer = setTimeout(() => setIsOpen(true), 400);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem("amd_update_assistant_live_v1", "true");
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 select-text">
      {/* Fond assombri neutre */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity"
        onClick={handleDismiss}
      />

      {/* Surface modale épurée style Stripe / Linear */}
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-zinc-100">
                Assistant interne Adventum Brain
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                Module de recherche, de synthèse et d&apos;assistance opérationnelle.
              </p>
            </div>
            <button
              onClick={handleDismiss}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label="Fermer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 space-y-3.5">
            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <FileText className="h-3.5 w-3.5" />
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-slate-900 dark:text-zinc-100">
                  Consultation réglementaire et catalogue
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400">
                  Accès aux dossiers AMM, statuts d&apos;instruction, variations et références produits.
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <ListChecks className="h-3.5 w-3.5" />
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-slate-900 dark:text-zinc-100">
                  Préparation d&apos;actions sous contrôle
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400">
                  Génération de propositions de tâches et de messages, soumises à confirmation avant exécution.
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <Shield className="h-3.5 w-3.5" />
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-slate-900 dark:text-zinc-100">
                  Sécurité et périmètre d&apos;accès
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400">
                  Filtrage des données sensibles et alignement strict sur vos droits d&apos;accès RBAC.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Pied de dialogue sobre */}
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/50 px-6 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/60">
          <span className="text-xs text-slate-500 dark:text-zinc-400">
            Pilotage &rarr; Assistant IA
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDismiss}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              Fermer
            </button>
            <Link
              href="/assistant"
              onClick={handleDismiss}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 transition dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <span>Accéder au module</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
