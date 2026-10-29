"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useState } from "react";
import { Brain, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  corrigerMemoire, effacerElementMemoire, effacerToutMaMemoire, listerMaMemoire, retenirMemoire,
} from "@/lib/actions/assistant-ia-actions";
import { LIBELLE_SORTE, MEMOIRE_MAX_CARACTERES, SORTES_MEMOIRE, estSorteMemoire, type ElementMemoire, type SorteMemoire } from "@/lib/agent/memoire-ui";

/**
 * LE PANNEAU « MA MÉMOIRE » — tout ce que l'assistant retient de la personne, et rien d'autre.
 *
 * Visible en entier, corrigeable ligne par ligne, effaçable élément par élément ou d'un coup.
 * Sur téléphone, il monte du bas de l'écran ; sur ordinateur, il s'ouvre sur le côté.
 */
export function MemoirePanel({ ouvert, onFermer }: { ouvert: boolean; onFermer: () => void }) {
  const [elements, setElements] = useState<ElementMemoire[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [edition, setEdition] = useState<{ id: string; texte: string } | null>(null);
  const [nouveau, setNouveau] = useState<{ texte: string; sorte: SorteMemoire } | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [confirmerTout, setConfirmerTout] = useState(false);

  const charger = useCallback(async () => {
    try {
      const r = await listerMaMemoire();
      if (r.ok) { setElements(r.elements); setErreur(null); } else setErreur(r.erreur);
    } catch {
      setErreur("La mémoire n'a pas pu être chargée (connexion ou serveur).");
    }
  }, []);

  useEffect(() => { if (ouvert) void charger(); }, [ouvert, charger]);

  useEffect(() => {
    if (!ouvert) return;
    const fermer = (e: KeyboardEvent) => { if (e.key === "Escape") onFermer(); };
    window.addEventListener("keydown", fermer);
    return () => window.removeEventListener("keydown", fermer);
  }, [ouvert, onFermer]);

  const agir = async (f: () => Promise<{ ok: boolean; erreur?: string }>) => {
    setOccupe(true);
    let r: { ok: boolean; erreur?: string };
    try {
      r = await f();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
      return false;
    } finally {
      setOccupe(false);
    }
    if (!r.ok) { setErreur(r.erreur ?? "Opération impossible."); return false; }
    setErreur(null);
    await charger();
    return true;
  };

  if (!ouvert) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end" role="dialog" aria-modal="true" aria-label="Ma mémoire">
      <button type="button" aria-label="Fermer" onClick={onFermer} className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]" />
      <div className="relative flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:max-h-none sm:w-[420px] sm:rounded-none dark:bg-zinc-950">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 sm:hidden" />
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
          <Brain className="h-4 w-4 text-violet-600" />
          <h2 className="flex-1 text-[15px] font-semibold text-slate-900 dark:text-zinc-100">Ma mémoire</h2>
          <button type="button" onClick={onFermer} aria-label="Fermer" className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
          <p className="text-[13px] leading-relaxed text-slate-600 dark:text-zinc-400">
            Ce que l&apos;assistant retient de vous — à vous seul, jamais partagé. Corrigez ou effacez à tout moment.
            Il ne retient rien sans votre confirmation, ni rémunération, ni coordonnée bancaire, ni pièce d&apos;identité.
          </p>
          {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>}

          {elements === null ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
          ) : elements.length === 0 && !nouveau ? (
            <p className="py-6 text-center text-[13px] text-slate-500">Rien pour l&apos;instant. Dites « retiens que… » à l&apos;assistant, ou ajoutez-le ici.</p>
          ) : (
            <ul className="space-y-2">
              {elements.map((e) => (
                <li key={e.id} className="rounded-xl border border-slate-200 px-3 py-2.5 dark:border-zinc-800">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{estSorteMemoire(e.sorte) ? LIBELLE_SORTE[e.sorte] : "Mémoire"}</p>
                  {edition?.id === e.id ? (
                    <div className="mt-1 space-y-2">
                      <textarea
                        value={edition.texte}
                        maxLength={MEMOIRE_MAX_CARACTERES}
                        onChange={(ev) => setEdition({ id: e.id, texte: ev.target.value })}
                        rows={2}
                        className="w-full resize-none rounded-lg border border-slate-300 px-2 py-1.5 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                      <div className="flex gap-2">
                        <button type="button" disabled={occupe} onClick={async () => { if (await agir(() => corrigerMemoire(e.id, edition.texte))) setEdition(null); }} className="inline-flex h-9 items-center gap-1 rounded-lg bg-slate-900 px-3 text-[13px] font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900">
                          <Check className="h-3.5 w-3.5" /> Enregistrer
                        </button>
                        <button type="button" onClick={() => setEdition(null)} className="h-9 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100 dark:hover:bg-zinc-800">Annuler</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-0.5 flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-sm text-slate-800 [overflow-wrap:anywhere] dark:text-zinc-200">{e.contenu}</p>
                      <button type="button" aria-label="Corriger" onClick={() => setEdition({ id: e.id, texte: e.contenu })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" aria-label="Effacer" disabled={occupe} onClick={() => agir(() => effacerElementMemoire(e.id))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {nouveau ? (
            <div className="space-y-2 rounded-xl border border-violet-200 p-3 dark:border-violet-900/60">
              <select
                value={nouveau.sorte}
                onChange={(e) => setNouveau({ ...nouveau, sorte: e.target.value as SorteMemoire })}
                className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {SORTES_MEMOIRE.map((s) => <option key={s} value={s}>{LIBELLE_SORTE[s]}</option>)}
              </select>
              <textarea
                autoFocus
                value={nouveau.texte}
                maxLength={MEMOIRE_MAX_CARACTERES}
                onChange={(e) => setNouveau({ ...nouveau, texte: e.target.value })}
                placeholder="Ex. : Ma société est Pharmagène ; je suis les produits de cardiologie."
                rows={2}
                className="w-full resize-none rounded-lg border border-slate-300 px-2 py-1.5 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <div className="flex gap-2">
                <button type="button" disabled={occupe || !nouveau.texte.trim()} onClick={async () => { if (await agir(() => retenirMemoire(nouveau.texte, nouveau.sorte))) setNouveau(null); }} className="inline-flex h-9 items-center gap-1 rounded-lg bg-violet-600 px-3 text-[13px] font-medium text-white disabled:opacity-60">
                  <Check className="h-3.5 w-3.5" /> Retenir
                </button>
                <button type="button" onClick={() => setNouveau(null)} className="h-9 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100 dark:hover:bg-zinc-800">Annuler</button>
              </div>
            </div>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
          <button type="button" onClick={() => setNouveau({ texte: "", sorte: "ORGANIZATIONAL_CONTEXT" })} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-[13px] font-medium text-slate-800 hover:bg-slate-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900">
            <Plus className="h-4 w-4" /> Ajouter
          </button>
          <div className="flex-1" />
          {elements && elements.length > 0 && (confirmerTout ? (
            <>
              <span className="text-[13px] text-slate-600">Tout effacer ?</span>
              <button type="button" disabled={occupe} onClick={async () => { await agir(effacerToutMaMemoire); setConfirmerTout(false); }} className="h-10 rounded-lg bg-red-600 px-3 text-[13px] font-medium text-white disabled:opacity-60">Oui, tout effacer</button>
              <button type="button" onClick={() => setConfirmerTout(false)} className="h-10 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100">Non</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmerTout(true)} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40">
              <Trash2 className="h-4 w-4" /> Tout effacer
            </button>
          ))}
        </footer>
      </div>
    </div>
  );
}
