"use client";

import React, { useState } from "react";
import { Check, Loader2, NotebookPen, Undo2, X } from "lucide-react";
import { accepterPropositionNote, annulerPropositionNote, refuserPropositionNote, toutAccepterNotes } from "@/modules/assistant-ia/actions-notes";
import type { PropositionNote } from "../domaine/notes/gestes";

/**
 * LA CARTE « MES NOTES » DANS LA CONVERSATION (décision 0026) — ce que l'assistant a PROPOSÉ de changer dans les
 * notes, pendant ce tour. Rien n'est écrit avant « Accepter » ; « Tout accepter » quand il y en a plusieurs ;
 * « Annuler » après. Les mêmes propositions sont surlignées dans le panneau « Mes notes ».
 */
const ETAT: Record<PropositionNote["etat"], string> = {
  PROPOSEE: "proposée", ACCEPTEE: "acceptée", REFUSEE: "refusée", ANNULEE: "annulée", PERIMEE: "ne s'applique plus",
};

export function NotesProposeesCard({ propositions, onOuvrirNotes }: { propositions: PropositionNote[]; onOuvrirNotes?: () => void }) {
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const enAttente = propositions.filter((p) => p.etat === "PROPOSEE");

  const agir = async (cle: string, geste: () => Promise<{ ok: boolean; erreur?: string }>) => {
    setEnCours(cle);
    setErreur(null);
    try {
      const r = await geste();
      if (!r.ok) setErreur(r.erreur ?? "Rien n'a été fait.");
    } catch {
      setErreur("La connexion a été interrompue. Réessayez.");
    } finally {
      setEnCours(null);
      // Le panneau et le fil relisent : la carte et la page montrent le même état.
      window.dispatchEvent(new Event("notes:relire"));
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    }
  };

  return (
    <div data-testid="carte-notes" className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[13px] dark:border-amber-900/60 dark:bg-amber-950/25">
      <div className="flex items-center gap-2">
        <NotebookPen aria-hidden className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <p className="flex-1 font-medium text-slate-900 dark:text-zinc-100">
          {enAttente.length ? `Mes notes — ${enAttente.length > 1 ? `${enAttente.length} modifications proposées` : "modification proposée"}` : "Mes notes"}
        </p>
        {onOuvrirNotes && <button type="button" onClick={onOuvrirNotes} className="text-[12px] font-medium text-violet-700 underline dark:text-violet-300">Voir dans mes notes</button>}
      </div>
      <ul className="mt-2 space-y-1.5">
        {propositions.map((p) => (
          <li key={p.id} data-testid="carte-notes-ligne" data-etat={p.etat} className="flex flex-wrap items-center gap-1.5">
            <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${p.etat === "REFUSEE" || p.etat === "ANNULEE" || p.etat === "PERIMEE" ? "text-slate-400 line-through" : "text-slate-700 dark:text-zinc-300"}`}>
              {p.resume} <span className="text-[11.5px] text-slate-500">· {ETAT[p.etat]}</span>
            </span>
            {p.etat === "PROPOSEE" && (
              <>
                <button type="button" disabled={!!enCours} onClick={() => void agir(p.id, () => accepterPropositionNote(p.id))} className="inline-flex h-8 items-center gap-1 rounded-lg bg-violet-600 px-2.5 font-medium text-white hover:bg-violet-700 disabled:opacity-60">
                  {enCours === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Accepter
                </button>
                <button type="button" disabled={!!enCours} onClick={() => void agir(p.id, () => refuserPropositionNote(p.id))} className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 font-medium text-slate-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900">
                  <X className="h-3.5 w-3.5" /> Refuser
                </button>
              </>
            )}
            {p.etat === "ACCEPTEE" && (
              <button type="button" disabled={!!enCours} onClick={() => void agir(p.id, () => annulerPropositionNote(p.id))} className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 font-medium text-slate-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900">
                <Undo2 className="h-3.5 w-3.5" /> Annuler
              </button>
            )}
          </li>
        ))}
      </ul>
      {enAttente.length > 1 && (
        <button type="button" disabled={!!enCours} onClick={() => void agir("tout", () => toutAccepterNotes(enAttente.map((p) => p.id)))} className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-3 font-medium text-white hover:bg-violet-700 disabled:opacity-60">
          {enCours === "tout" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Tout accepter
        </button>
      )}
      {erreur && <p role="alert" className="mt-1.5 text-red-700 dark:text-red-400">{erreur}</p>}
    </div>
  );
}
