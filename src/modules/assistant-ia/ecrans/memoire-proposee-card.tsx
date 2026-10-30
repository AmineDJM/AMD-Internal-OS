"use client";

import React, { useState } from "react";
import { Brain, Check, Loader2, X } from "lucide-react";
import { retenirMemoire } from "@/modules/assistant-ia/actions";
import type { MemoireProposee } from "../domaine/memoire-ui";

/**
 * LA CARTE « RETENIR » — l'assistant a PROPOSÉ de retenir un fait ; rien n'est écrit avant ce
 * geste. Retenu, il rejoint la mémoire que la personne voit, corrige et efface à tout moment.
 */
export function MemoireProposeeCard({ memoire }: { memoire: MemoireProposee }) {
  const [etat, setEtat] = useState<"proposee" | "en-cours" | "retenue" | "ignoree">("proposee");
  const [erreur, setErreur] = useState<string | null>(null);

  const retenir = async () => {
    setEtat("en-cours");
    setErreur(null);
    const r = await retenirMemoire(memoire.contenu, memoire.sorte);
    if (r.ok) setEtat("retenue");
    else { setEtat("proposee"); setErreur(r.erreur); }
  };

  if (etat === "ignoree") return null;
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-3 text-[13px] dark:border-violet-900/60 dark:bg-violet-950/30">
      <div className="flex items-start gap-2">
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-slate-900 dark:text-zinc-100">
            {/* Décision 0027 : la mémoire est commune à toutes les conversations — le fil le DIT quand elle change. */}
            {etat === "retenue" ? <span role="status">Mémoire mise à jour</span> : "Retenir dans votre mémoire ?"}
          </p>
          <p className="mt-0.5 text-slate-700 [overflow-wrap:anywhere] dark:text-zinc-300">« {memoire.contenu} »</p>
          {erreur && <p className="mt-1 text-red-700 dark:text-red-400">{erreur}</p>}
        </div>
      </div>
      {etat !== "retenue" && (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={retenir}
            disabled={etat === "en-cours"}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-3 font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {etat === "en-cours" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Retenir
          </button>
          <button
            type="button"
            onClick={() => setEtat("ignoree")}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 font-medium text-slate-600 hover:bg-white dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            <X className="h-3.5 w-3.5" /> Ignorer
          </button>
        </div>
      )}
    </div>
  );
}
