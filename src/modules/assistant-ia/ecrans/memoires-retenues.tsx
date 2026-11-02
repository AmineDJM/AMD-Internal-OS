"use client";

import React, { useState } from "react";
import { Brain, Loader2, Undo2 } from "lucide-react";
import { annulerSouvenirRetenu } from "@/modules/assistant-ia/actions";
import { ligneRetenu, type MemoireRetenue } from "../domaine/memoire-ui";

/** L'événement qui ouvre « Ce qu'il retient » (l'app et l'écran de l'ERP l'écoutent) ; et celui qui dit qu'elle a changé. */
export const OUVRIR_MEMOIRE = "assistant-memoire:ouvrir";
export const MEMOIRE_CHANGEE = "assistant-memoire:changee";

/**
 * M1 (décision 0045) — LA LIGNE DISCRÈTE « Retenu : … (annuler) » sous une réponse : ce que la mémoire automatique a
 * retenu de ce tour. Annuler défait exactement l'ajout (l'ancien fait revient s'il avait été remplacé).
 */
export function MemoiresRetenues({ memoires }: { memoires: MemoireRetenue[] }) {
  const [annules, setAnnules] = useState<Set<string>>(() => new Set(memoires.filter((m) => m.annule).map((m) => m.id)));
  const [occupe, setOccupe] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const annuler = async (id: string) => {
    setOccupe(id);
    try {
      const r = await annulerSouvenirRetenu(id);
      if (!r.ok) { setErreur(r.erreur); return; }
      setErreur(null);
      setAnnules((s) => new Set(s).add(id));
      window.dispatchEvent(new Event(MEMOIRE_CHANGEE));
    } catch {
      setErreur("L'annulation n'a pas abouti (connexion ou serveur).");
    } finally {
      setOccupe(null);
    }
  };

  return (
    <div className="mt-2 space-y-1" data-testid="memoires-retenues">
      {memoires.map((m) => {
        const annule = annules.has(m.id) || m.annule;
        return (
          <p key={m.id} className="text-[12px] leading-5 text-slate-500 dark:text-zinc-400">
            <Brain className="mr-1 inline h-3 w-3 align-[-2px] text-violet-500" aria-hidden />
            <span className={annule ? "line-through" : undefined}>{ligneRetenu(m)}</span>
            {" — "}
            {annule ? (
              <span className="text-slate-400">annulé</span>
            ) : m.depasse ? (
              <span className="text-slate-400">mis à jour depuis</span>
            ) : (
              <button type="button" disabled={occupe === m.id} onClick={() => annuler(m.id)} className="inline-flex items-center gap-0.5 font-medium text-violet-700 underline-offset-2 hover:underline disabled:opacity-60 dark:text-violet-300">
                {occupe === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} annuler
              </button>
            )}
            {" · "}
            <button type="button" onClick={() => window.dispatchEvent(new Event(OUVRIR_MEMOIRE))} className="text-slate-400 underline-offset-2 hover:underline">
              voir
            </button>
          </p>
        );
      })}
      {erreur && <p className="text-[12px] text-red-600 dark:text-red-400">{erreur}</p>}
    </div>
  );
}
