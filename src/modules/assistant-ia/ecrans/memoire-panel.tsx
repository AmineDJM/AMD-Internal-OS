"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, Check, Loader2, MessageSquare, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  corrigerMemoire, effacerElementMemoire, effacerToutMaMemoire, listerMaMemoire, reglerMaMemoireAuto, retenirMemoire,
} from "@/modules/assistant-ia/actions";
import {
  GROUPES_MEMOIRE, LIBELLE_ORIGINE, LIBELLE_SORTE, MEMOIRE_MAX_CARACTERES, SORTES_MEMOIRE, estSorteMemoire,
  type ElementMemoire, type OrigineMemoire, type SorteMemoire,
} from "../domaine/memoire-ui";
import { MEMOIRE_CHANGEE } from "./memoires-retenues";

const plier = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const dateCourte = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * LE PANNEAU « CE QU'IL RETIENT » — tout ce que l'assistant retient de la personne, et rien d'autre (M1, décision 0045).
 *
 * Groupé (Moi, Ma vie, Mon travail, Comment me répondre), cherchable, corrigeable en ligne, effaçable élément par élément
 * ou d'un coup ; chaque souvenir dit d'où il vient (la conversation, ouvrable) et quand. Le réglage « mémoire
 * automatique » s'y règle. Il se relit seul quand la mémoire change (une annulation dans la conversation, une capture).
 * Sur téléphone, il monte du bas de l'écran ; sur ordinateur, il s'ouvre sur le côté.
 */
export function MemoirePanel({ ouvert, onFermer, onOuvrirConversation }: {
  ouvert: boolean;
  onFermer: () => void;
  /** Ouvrir la conversation d'origine d'un souvenir (l'app et l'écran de l'ERP savent chacun le faire). */
  onOuvrirConversation?: (id: string) => void;
}) {
  const [elements, setElements] = useState<ElementMemoire[] | null>(null);
  const [auto, setAuto] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [edition, setEdition] = useState<{ id: string; texte: string } | null>(null);
  const [nouveau, setNouveau] = useState<{ texte: string; sorte: SorteMemoire } | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [confirmerTout, setConfirmerTout] = useState(false);
  const [recherche, setRecherche] = useState("");

  const charger = useCallback(async () => {
    try {
      const r = await listerMaMemoire();
      if (r.ok) { setElements(r.elements); setAuto(r.auto); setErreur(null); } else setErreur(r.erreur);
    } catch {
      setErreur("La mémoire n'a pas pu être chargée (connexion ou serveur).");
    }
  }, []);

  useEffect(() => { if (ouvert) void charger(); }, [ouvert, charger]);
  // Ouvert, il suit la mémoire : une annulation dans la conversation, ou une nouvelle capture (relue toutes les 10 s).
  useEffect(() => {
    if (!ouvert) return;
    const relire = () => void charger();
    window.addEventListener(MEMOIRE_CHANGEE, relire);
    const minuteur = setInterval(relire, 10_000);
    return () => { window.removeEventListener(MEMOIRE_CHANGEE, relire); clearInterval(minuteur); };
  }, [ouvert, charger]);

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

  const groupes = useMemo(() => {
    const q = plier(recherche.trim());
    const vus = (elements ?? []).filter((e) => !q || plier(`${e.contenu} ${estSorteMemoire(e.sorte) ? LIBELLE_SORTE[e.sorte] : ""}`).includes(q));
    const rangees = GROUPES_MEMOIRE.map((g) => ({
      titre: g.titre,
      sections: g.sortes.map((s) => ({ sorte: s, items: vus.filter((e) => e.sorte === s) })).filter((x) => x.items.length),
    }));
    const autres = vus.filter((e) => !estSorteMemoire(e.sorte));
    if (autres.length) rangees.push({ titre: "Autres", sections: [{ sorte: "USER_PREFERENCE", items: autres }] });
    return { rangees: rangees.filter((g) => g.sections.length), total: vus.length };
  }, [elements, recherche]);

  if (!ouvert) return null;

  const ligne = (e: ElementMemoire) => (
    <li key={e.id} className="rounded-xl border border-slate-200 px-3 py-2.5 dark:border-zinc-800" data-testid="souvenir">
      {edition?.id === e.id ? (
        <div className="space-y-2">
          <textarea
            value={edition.texte}
            maxLength={MEMOIRE_MAX_CARACTERES}
            onChange={(ev) => setEdition({ id: e.id, texte: ev.target.value })}
            rows={2}
            autoFocus
            aria-label="Corriger le souvenir"
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
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-slate-800 [overflow-wrap:anywhere] dark:text-zinc-200">{e.contenu}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-500 dark:text-zinc-500">
              <span>{LIBELLE_ORIGINE[e.origine as OrigineMemoire] ?? "retenu"} · {dateCourte(e.sourceLe ?? e.modifieLe)}</span>
              {e.versionsAnterieures ? <span>· mis à jour ({e.versionsAnterieures} version{e.versionsAnterieures > 1 ? "s" : ""} avant)</span> : null}
              {e.conversation && onOuvrirConversation && (
                <button type="button" onClick={() => onOuvrirConversation(e.conversation!.id)} className="inline-flex items-center gap-0.5 text-violet-700 underline-offset-2 hover:underline dark:text-violet-300">
                  <MessageSquare className="h-3 w-3" /> {e.conversation.titre?.slice(0, 40) || "la conversation"}
                </button>
              )}
            </p>
          </div>
          <button type="button" aria-label="Corriger" onClick={() => setEdition({ id: e.id, texte: e.contenu })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Effacer" disabled={occupe} onClick={() => agir(() => effacerElementMemoire(e.id))} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </li>
  );

  const total = elements?.length ?? 0;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end" role="dialog" aria-modal="true" aria-label="Ce qu'il retient">
      <button type="button" aria-label="Fermer" onClick={onFermer} className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]" />
      <div className="relative flex max-h-[88dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:max-h-none sm:w-[440px] sm:rounded-none dark:bg-zinc-950">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 sm:hidden" />
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
          <Brain className="h-4 w-4 text-violet-600" />
          <h2 className="flex-1 text-[15px] font-semibold text-slate-900 dark:text-zinc-100">
            Ce qu&apos;il retient {elements ? <span className="font-normal text-slate-500" data-testid="compteur-memoire">· {total}</span> : null}
          </h2>
          <button type="button" onClick={onFermer} aria-label="Fermer" className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
          <p className="text-[13px] leading-relaxed text-slate-600 dark:text-zinc-400">
            Ce que vous dites de vous — famille, études, voyages, goûts, habitudes de travail — est retenu pour vous seul,
            jamais partagé. Corrigez ou effacez à tout moment. Ni rémunération, ni coordonnée bancaire, ni pièce d&apos;identité ;
            rien d&apos;une conversation privée.
          </p>
          <label className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-[13px] dark:bg-zinc-900">
            <span className="text-slate-800 dark:text-zinc-200">
              Mémoire automatique
              <span className="block text-[11px] text-slate-500">{auto ? "Il retient de lui-même ce que vous dites de vous." : "Il ne retient que ce que vous confirmez."}</span>
            </span>
            <input type="checkbox" role="switch" aria-label="Mémoire automatique" checked={auto} disabled={occupe}
              onChange={(ev) => { const v = ev.target.checked; setAuto(v); void agir(() => reglerMaMemoireAuto(v)); }}
              className="h-5 w-9 cursor-pointer accent-violet-600" />
          </label>
          {total > 4 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input type="search" value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Chercher dans ce qu'il retient"
                className="h-10 w-full rounded-lg border border-slate-200 pl-8 pr-2 text-base sm:text-sm dark:border-zinc-800 dark:bg-zinc-900" />
            </div>
          )}
          {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>}

          {elements === null ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
          ) : total === 0 && !nouveau ? (
            <p className="py-6 text-center text-[13px] text-slate-500">Rien pour l&apos;instant. Parlez-lui de vous : il s&apos;en souviendra. Ou ajoutez-le ici.</p>
          ) : groupes.total === 0 ? (
            <p className="py-4 text-center text-[13px] text-slate-500">Aucun souvenir ne correspond à « {recherche} ».</p>
          ) : (
            groupes.rangees.map((g) => (
              <section key={g.titre} className="space-y-2">
                <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{g.titre}</h3>
                {g.sections.map((s) => (
                  <div key={s.sorte} className="space-y-1.5">
                    <p className="text-[11px] font-medium text-violet-700 dark:text-violet-300">{LIBELLE_SORTE[s.sorte]}</p>
                    <ul className="space-y-1.5">{s.items.map(ligne)}</ul>
                  </div>
                ))}
              </section>
            ))
          )}

          {nouveau ? (
            <div className="space-y-2 rounded-xl border border-violet-200 p-3 dark:border-violet-900/60">
              <select
                value={nouveau.sorte}
                onChange={(e) => setNouveau({ ...nouveau, sorte: e.target.value as SorteMemoire })}
                aria-label="Sorte de souvenir"
                className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {SORTES_MEMOIRE.map((s) => <option key={s} value={s}>{LIBELLE_SORTE[s]}</option>)}
              </select>
              <textarea
                autoFocus
                value={nouveau.texte}
                maxLength={MEMOIRE_MAX_CARACTERES}
                onChange={(e) => setNouveau({ ...nouveau, texte: e.target.value })}
                placeholder="Ex. : Ma fille s'appelle Lina ; je préfère des réponses courtes."
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
          <button type="button" onClick={() => setNouveau({ texte: "", sorte: "PERSONNEL_IDENTITE" })} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-[13px] font-medium text-slate-800 hover:bg-slate-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900">
            <Plus className="h-4 w-4" /> Ajouter
          </button>
          <div className="flex-1" />
          {total > 0 && (confirmerTout ? (
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
