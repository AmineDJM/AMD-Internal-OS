"use client";

import React, { useEffect, useState } from "react";
import { Radar, ThumbsDown, ThumbsUp } from "lucide-react";
import { jugerConstat, suggestionsPourDossier } from "@/modules/assistant-ia/actions-proactivite";
import { sansBloquer } from "@/lib/journal";

/**
 * À L'OUVERTURE D'UN DOSSIER (J12, décision 0024) — ce que les veilleurs de la personne ont constaté sur CETTE
 * fiche, au moment où elle la regarde. Aucune interruption n'est consommée ; rien ne s'affiche s'il n'y a rien.
 */
type Suggestion = { id: string; titre: string; detail: string; gravite: string; retour: string | null };

export function SuggestionsDossier({ entiteType, entiteId }: { entiteType: string; entiteId: string }) {
  const [liste, setListe] = useState<Suggestion[]>([]);
  useEffect(() => {
    void suggestionsPourDossier(entiteType, entiteId).then((r) => { if (r.ok) setListe(r.suggestions); }).catch(sansBloquer("suggestions-dossier.charger"));
  }, [entiteType, entiteId]);
  if (!liste.length) return null;
  const juger = (id: string, retour: "UTILE" | "PAS_UTILE") => {
    setListe((l) => l.map((s) => (s.id === id ? { ...s, retour } : s)));
    void jugerConstat(id, retour).catch(sansBloquer("suggestions-dossier.juger"));
  };
  return (
    <aside aria-label="Votre assistant a remarqué" className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/30">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-violet-800 dark:text-violet-300"><Radar className="h-3.5 w-3.5" /> Votre assistant a remarqué</p>
      <ul className="mt-1.5 space-y-1.5">
        {liste.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 text-[13px] text-slate-800 dark:text-zinc-200">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><strong className="font-medium">{s.titre}</strong> — {s.detail}</span>
            <button type="button" aria-label="Utile" aria-pressed={s.retour === "UTILE"} onClick={() => juger(s.id, "UTILE")} className={`flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white dark:hover:bg-zinc-900 ${s.retour === "UTILE" ? "text-emerald-600" : "text-slate-500"}`}><ThumbsUp className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Pas utile" aria-pressed={s.retour === "PAS_UTILE"} onClick={() => juger(s.id, "PAS_UTILE")} className={`flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white dark:hover:bg-zinc-900 ${s.retour === "PAS_UTILE" ? "text-red-600" : "text-slate-500"}`}><ThumbsDown className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
