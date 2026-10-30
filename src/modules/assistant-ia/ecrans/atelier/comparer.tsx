"use client";

import React from "react";
import { X } from "lucide-react";
import type { VueArtefact } from "@/platform/ia/artifact/view-types";
import { zonesModifiees } from "@/platform/ia/artifact/atelier/gestes";
import type { comparerOnglet } from "@/modules/assistant-ia/actions-atelier";
import { SceneAtelier, type Navigation } from "./document";

type Comparatif = Awaited<ReturnType<typeof comparerOnglet>>;

/**
 * COMPARER — AVANT (la version ouverte) et APRÈS (l'état courant, non enregistré compris), côte à côte, avec ce
 * qui diffère RÉELLEMENT (relu par le moteur, §52), pas ce qui a été demandé.
 */
export function ComparaisonAtelier({ vue, c, onFermer }: { vue: VueArtefact; c: Comparatif; onFermer: () => void }) {
  const [nav, setNav] = React.useState<Navigation>({ diapo: null, feuille: null, page: null });
  const maj = (n: Partial<Navigation>) => setNav((a) => ({ ...a, ...n }));
  const zones = c.avant && c.apres ? zonesModifiees(c.avant, c.apres).ids : [];
  return (
    <div role="dialog" aria-label="Comparer avant / après" className="absolute inset-0 z-20 flex flex-col bg-white dark:bg-zinc-950" data-testid="atelier-comparaison">
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-zinc-100">Avant (v{c.versionAvant}) / après</h3>
        <p className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-zinc-400">{c.comparaison?.resume}</p>
        <button type="button" onClick={onFermer} aria-label="Fermer la comparaison" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800"><X className="h-4 w-4" /></button>
      </header>
      {!c.ok && <p className="p-3 text-sm text-amber-700">{c.erreur}</p>}
      {c.ok && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-slate-200 md:grid-cols-2 dark:bg-zinc-800">
          {c.avant && vue.format !== "PDF" && (
            <div className="min-h-0 overflow-auto bg-white dark:bg-zinc-950">
              <p className="sticky top-0 z-10 bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-500 dark:bg-zinc-900">Avant</p>
              <SceneAtelier vue={{ ...vue, contenu: c.avant }} nav={nav} zones={[]} anime={false} onNav={maj} />
            </div>
          )}
          {c.apres && (
            <div className="min-h-0 overflow-auto bg-white dark:bg-zinc-950">
              <p className="sticky top-0 z-10 bg-amber-50 px-2 py-1 text-[11px] font-semibold uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">Après</p>
              <SceneAtelier vue={{ ...vue, contenu: c.apres }} nav={nav} zones={zones} anime={false} onNav={maj} />
            </div>
          )}
        </div>
      )}
      {c.comparaison && c.comparaison.changements.length > 0 && (
        <ul className="max-h-40 overflow-auto border-t border-slate-200 px-3 py-2 text-xs dark:border-zinc-800">
          {c.comparaison.changements.map((ch, i) => (
            <li key={i} className="py-0.5 text-slate-700 dark:text-zinc-300"><strong>{ch.objet}</strong> — {ch.quoi}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
