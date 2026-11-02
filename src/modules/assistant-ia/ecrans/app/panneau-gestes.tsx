"use client";

import React, { useEffect, useState } from "react";
import { History, Loader2, X } from "lucide-react";
import { listerGestesAssistant } from "../../actions-gestes";
import { GestesAssistant } from "../gestes-assistant";
import { useEchap } from "../use-echap";

type Gestes = Extract<Awaited<ReturnType<typeof listerGestesAssistant>>, { ok: true }>["gestes"];

/**
 * « CE QUE L'ASSISTANT A FAIT » DANS L'APP (audit M1, écart ERP ↔ app) — la page `/assistant/gestes` de l'ERP n'est pas
 * servie en mode app : le même écran (`GestesAssistant`, journal des effets J7, « Annuler ») s'ouvre ici en panneau,
 * monté du bas sur téléphone, sur le côté au bureau.
 */
export function PanneauGestes({ ouvert, onFermer, superAdmin }: { ouvert: boolean; onFermer: () => void; superAdmin: boolean }) {
  const [gestes, setGestes] = useState<Gestes | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (!ouvert) return;
    setGestes(null);
    void (async () => {
      try {
        const r = await listerGestesAssistant(false);
        if (r.ok) setGestes(r.gestes); else setErreur(r.error);
      } catch {
        setErreur("L'historique n'a pas pu être chargé (connexion ou serveur).");
      }
    })();
  }, [ouvert]);
  useEchap(onFermer);

  if (!ouvert) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end" role="dialog" aria-modal="true" aria-label="Ce qu'Adam a fait">
      <button type="button" aria-label="Fermer" onClick={onFermer} className="absolute inset-0 bg-slate-950/40" />
      <div className="relative flex max-h-[88dvh] w-full flex-col rounded-t-2xl bg-[var(--aia-panneau)] text-[var(--aia-texte)] shadow-2xl sm:max-h-none sm:w-[480px] sm:rounded-none">
        <header className="flex items-center gap-2 border-b border-[var(--aia-filet)] px-4 py-3">
          <History className="h-4 w-4" aria-hidden />
          <h2 className="flex-1 text-[15px] font-semibold">Ce qu&apos;Adam a fait</h2>
          <button type="button" onClick={onFermer} aria-label="Fermer le panneau" className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--aia-survol)]">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {erreur ? <p className="text-[13px] text-[var(--aia-danger)]">{erreur}</p>
            : gestes === null ? <p className="flex items-center gap-2 text-[13px]"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</p>
              : <GestesAssistant initiaux={gestes} superAdmin={superAdmin} />}
        </div>
      </div>
    </div>
  );
}
