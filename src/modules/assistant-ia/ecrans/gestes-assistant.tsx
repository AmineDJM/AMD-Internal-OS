"use client";

import React, { useState, useTransition } from "react";
import { Undo2, Loader2, CheckCircle2, AlertTriangle, MinusCircle, RotateCcw } from "lucide-react";
import { annulerGestesAssistant, apercevoirAnnulation, listerGestesAssistant } from "../actions-gestes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CE QUE L'ASSISTANT A FAIT » (lot J7, décision 0029) — l'historique des gestes de l'assistant, avec « Annuler ».
 *
 * Chaque geste dit ce qu'il a écrit (lu dans le journal des effets). « Annuler » montre D'ABORD ce qui se défera,
 * ce qui se compensera et ce qui est impossible — puis, après le clic, ce qui l'a été vraiment, effet par effet.
 * Jamais un « annulé » de façade : un lot rend son détail geste par geste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Liste = Extract<Awaited<ReturnType<typeof listerGestesAssistant>>, { ok: true }>["gestes"];
type Geste = Liste[number];
type Plan = Extract<Awaited<ReturnType<typeof apercevoirAnnulation>>, { ok: true }>["plan"];
type Detail = Plan["details"][number];

const ORIGINES: Record<string, string> = { carte: "Carte confirmée", travail: "Étape d'un travail", mandat: "Sous mandat" };

const ISSUES: Record<Detail["issue"], { mot: string; ton: string; Icone: typeof CheckCircle2 }> = {
  ANNULE: { mot: "Annulé", ton: "text-emerald-700 dark:text-emerald-300", Icone: CheckCircle2 },
  COMPENSE: { mot: "Compensé", ton: "text-sky-700 dark:text-sky-300", Icone: RotateCcw },
  IMPOSSIBLE: { mot: "Impossible", ton: "text-amber-700 dark:text-amber-300", Icone: AlertTriangle },
  SANS_OBJET: { mot: "Sans objet", ton: "text-zinc-500 dark:text-zinc-400", Icone: MinusCircle },
};

const quand = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Details({ plan }: { plan: Plan; prevu?: boolean }) {
  return (
    <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="font-medium">{plan.resume}</p>
      <ul className="mt-1.5 space-y-1">
        {plan.details.map((d) => {
          const i = ISSUES[d.issue];
          return (
            <li key={d.effetId} className="flex gap-1.5">
              <i.Icone className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${i.ton}`} aria-hidden />
              <span className="[overflow-wrap:anywhere]">
                <strong className={i.ton}>{i.mot}</strong> — {d.quoi} : {d.pourquoi}.
                {d.aLaPlace ? <span className="opacity-80"> À la place : {d.aLaPlace}.</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function GestesAssistant({ initiaux, superAdmin }: { initiaux: Liste; superAdmin: boolean }) {
  const [gestes, setGestes] = useState<Liste>(initiaux);
  const [tous, setTous] = useState(false);
  const [choisis, setChoisis] = useState<Set<string>>(new Set());
  const [apercus, setApercus] = useState<Record<string, Plan>>({});
  const [comptes, setComptes] = useState<Record<string, Plan | string>>({});
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, demarrer] = useTransition();

  const recharger = (t = tous) => demarrer(async () => {
    const r = await listerGestesAssistant(t);
    if (r.ok) setGestes(r.gestes); else setErreur(r.error);
  });

  const apercevoir = (g: Geste) => demarrer(async () => {
    setErreur(null);
    const r = await apercevoirAnnulation(g.id);
    if (r.ok) setApercus((a) => ({ ...a, [g.id]: r.plan })); else setErreur(r.error);
  });

  const annuler = (ids: string[]) => demarrer(async () => {
    setErreur(null);
    const r = await annulerGestesAssistant(ids);
    if (!r.ok) { setErreur(r.error); return; }
    setComptes((c) => ({ ...c, ...Object.fromEntries(r.comptes.map((x) => [x.gesteId, "refus" in x ? x.refus : x])) }));
    setChoisis(new Set());
    setApercus({});
    const l = await listerGestesAssistant(tous);
    if (l.ok) setGestes(l.gestes);
  });

  const basculer = (id: string) => setChoisis((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const annulables = gestes.filter((g) => !g.annuleLe && g.resultat === "FAIT");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-0">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Ce que l&apos;assistant a fait</h1>
        <p className="text-sm text-muted-foreground">
          Chaque geste de l&apos;assistant en votre nom — cartes confirmées, étapes de travaux, gestes sous mandat — avec ce
          qu&apos;il a écrit. « Annuler » défait ce qui est encore tel qu&apos;il l&apos;a laissé, compense ce qui se compense, et dit
          ce qui est impossible, sans jamais écraser ce que quelqu&apos;un a changé depuis.
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {superAdmin && (
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={tous} onChange={(e) => { setTous(e.target.checked); recharger(e.target.checked); }} />
              Les gestes de toutes les personnes
            </label>
          )}
          {choisis.size > 0 && (
            <button type="button" disabled={enCours} onClick={() => annuler([...choisis])}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
              <Undo2 className="h-3.5 w-3.5" aria-hidden /> Annuler la sélection ({choisis.size})
            </button>
          )}
          {enCours && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="En cours" />}
        </div>
        {erreur && <p className="rounded-lg bg-destructive/10 p-2 text-xs font-medium text-destructive">{erreur}</p>}
      </header>

      {gestes.length === 0 && <p className="text-sm text-muted-foreground">L&apos;assistant n&apos;a encore rien fait en votre nom.</p>}

      <ul className="flex flex-col gap-3">
        {gestes.map((g) => {
          const compte = comptes[g.id];
          const annulable = annulables.includes(g);
          return (
            <li key={g.id} className="rounded-2xl border border-zinc-200 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="flex items-start gap-2">
                {annulable && (
                  <input type="checkbox" aria-label={`Choisir « ${g.libelle} »`} className="mt-1 h-4 w-4" checked={choisis.has(g.id)} onChange={() => basculer(g.id)} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                    <span className="[overflow-wrap:anywhere]">{g.libelle}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">{ORIGINES[g.origine] ?? g.origine} · {quand(g.quand)}{tous && g.principal ? ` · ${g.principal}` : ""}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-300">
                    {g.resultat === "ECHEC" ? `Échec : ${g.message ?? "sans motif"}. ` : ""}{g.resume}
                  </p>
                  {g.ecart && <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">L&apos;écriture réelle a différé de la simulation montrée sur la carte (le monde avait changé entre-temps).</p>}
                  {g.annuleLe && <p className="mt-0.5 text-[11px] text-muted-foreground">Annulé le {quand(g.annuleLe)}.</p>}
                </div>
                {annulable && !apercus[g.id] && (
                  <button type="button" disabled={enCours} onClick={() => apercevoir(g)}
                    className="inline-flex h-10 shrink-0 items-center gap-1 rounded-xl border border-zinc-200 px-3 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                    <Undo2 className="h-3.5 w-3.5" aria-hidden /> Annuler…
                  </button>
                )}
              </div>
              {apercus[g.id] && !compte && (
                <>
                  <Details plan={apercus[g.id]} prevu />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setApercus((a) => { const n = { ...a }; delete n[g.id]; return n; })}
                      className="h-10 rounded-xl border border-zinc-200 px-3 text-xs dark:border-zinc-700">Garder</button>
                    <button type="button" disabled={enCours} onClick={() => annuler([g.id])}
                      className="h-10 rounded-xl bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">Annuler ce geste</button>
                  </div>
                </>
              )}
              {typeof compte === "string" && <p className="mt-2 text-xs text-destructive">{compte}</p>}
              {compte && typeof compte !== "string" && <Details plan={compte} prevu={false} />}
              {!compte && g.annulation && <Details plan={g.annulation as Plan} prevu={false} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
