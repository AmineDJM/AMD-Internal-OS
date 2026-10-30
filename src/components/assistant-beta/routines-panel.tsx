"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useState } from "react";
import { AlarmClock, Loader2, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import {
  basculerMaRoutine, executerMaRoutine, lireMonPassage, listerMesRoutines, supprimerMaRoutine,
} from "@/lib/actions/assistant-ia-actions";
import { MarkdownMessage } from "./markdown-message";
import { PanneauLateral } from "./panneau-lateral";
import { WorkspaceBlocks } from "@/components/chief/workspace/blocks";
import type { WorkspaceBlock } from "@/lib/assistant/workspace/protocol";

/**
 * LE PANNEAU « ROUTINES » — ce que la personne a programmé, et ce que chaque passage a rapporté.
 *
 * Chaque routine : ce qu'elle fait, quand (heure d'Alger), son état, son prochain passage ; ses
 * derniers passages, non lus marqués d'un point. Un passage s'ouvre en entier (rapport, blocs,
 * outils lus — ou la cause de l'échec). Pause, reprise, exécution immédiate, suppression : ici.
 * La création passe par la conversation (« chaque dimanche à 8 h, fais-moi… ») et sa carte.
 */

type Liste = Extract<Awaited<ReturnType<typeof listerMesRoutines>>, { ok: true }>;
type Routine = Liste["routines"][number];
type Passage = Extract<Awaited<ReturnType<typeof lireMonPassage>>, { ok: true }>["passage"];

const ETAT: Record<string, { libelle: string; classe: string }> = {
  ACTIVE: { libelle: "Active", classe: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" },
  PAUSED: { libelle: "En pause", classe: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" },
  ENDED: { libelle: "Terminée", classe: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400" },
};
const PASSAGE: Record<string, string> = { SUCCES: "Rapport", RIEN_DE_NOUVEAU: "Rien de nouveau", ECHEC: "Échec", IGNOREE: "Ignoré" };

const quand = (iso: string) => new Date(iso).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });

export function RoutinesPanel({ ouvert, onFermer, routineInitiale, onNonLus }: {
  ouvert: boolean; onFermer: () => void; routineInitiale?: string | null; onNonLus?: (n: number) => void;
}) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [passage, setPassage] = useState<Passage | null>(null);
  const [aSupprimer, setASupprimer] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const r = await listerMesRoutines();
      if (r.ok) { setRoutines(r.routines); setErreur(null); onNonLus?.(r.nonLus); } else setErreur(r.erreur);
    } catch {
      setErreur("Les routines n'ont pas pu être chargées (connexion ou serveur).");
    }
  }, [onNonLus]);

  const ouvrir = useCallback(async (runId: string) => {
    const r = await lireMonPassage(runId);
    if (r.ok) { setPassage(r.passage); void charger(); } else setErreur(r.erreur);
  }, [charger]);

  useEffect(() => { if (ouvert) void charger(); }, [ouvert, charger]);
  // Arrivé par la notification (« /assistant?routine=… ») : le dernier passage de CETTE routine s'ouvre.
  const [initialeVue, setInitialeVue] = useState(false);
  useEffect(() => {
    if (!ouvert || !routineInitiale || initialeVue || !routines) return;
    setInitialeVue(true);
    const dernier = routines.find((r) => r.id === routineInitiale)?.passages[0];
    if (dernier) void ouvrir(dernier.id);
  }, [ouvert, routineInitiale, initialeVue, routines, ouvrir]);

  const agir = async (cle: string, f: () => Promise<{ ok: boolean; erreur?: string; runId?: string }>) => {
    setOccupe(cle);
    let r: { ok: boolean; erreur?: string; runId?: string };
    try {
      r = await f();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
      return;
    } finally {
      setOccupe(null);
    }
    if (!r.ok) { setErreur(r.erreur ?? "Opération impossible."); return; }
    setErreur(null);
    await charger();
    if (r.runId) await ouvrir(r.runId);
  };

  if (!ouvert) return null;

  return (
    <PanneauLateral
      etiquette="Mes routines" titre={passage ? passage.titre : "Mes routines"} icone={<AlarmClock className="h-4 w-4 text-violet-600" />}
      onRetour={passage ? () => setPassage(null) : undefined} libelleRetour="Retour aux routines"
      onFermer={onFermer}
      pied={passage ? null : <>Une routine lit l&apos;ERP avec vos droits du moment et cherche sur le web ; elle n&apos;envoie rien et ne crée rien. Heures d&apos;Alger.</>}
    >
      {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>}

      {passage ? (
        <article className="space-y-3">
          <p className="text-[12px] text-slate-500">{quand(passage.debutLe)} · {PASSAGE[passage.statut] ?? passage.statut}</p>
          {passage.erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{passage.erreur}</p>}
          {passage.contenu && <div className="text-sm text-slate-800 dark:text-zinc-200"><MarkdownMessage texte={passage.contenu} /></div>}
          {Array.isArray(passage.blocs) && passage.blocs.length > 0 && (
            <WorkspaceBlocks composition={{ source: "assistant-ia", blocks: passage.blocs as unknown as WorkspaceBlock[] }} />
          )}
          {Array.isArray(passage.outils) && passage.outils.length > 0 && (
            <p className="text-[12px] text-slate-500">Consulté : {(passage.outils as string[]).join(" · ")}</p>
          )}
        </article>
      ) : routines === null ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : routines.length === 0 ? (
        <div className="space-y-2 py-6 text-center text-[13px] text-slate-500">
          <p>Aucune routine pour l&apos;instant.</p>
          <p>Demandez-la à l&apos;assistant : « Chaque dimanche à 8 h, fais-moi un briefing du marché pharmaceutique en Algérie. »</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {routines.map((r) => (
            <li key={r.id} className="rounded-xl border border-slate-200 p-3 dark:border-zinc-800">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-100">{r.titre}</p>
                  <p className="mt-0.5 text-[12px] text-slate-600 dark:text-zinc-400">{r.quand}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ETAT[r.statut]?.classe ?? ""}`}>{ETAT[r.statut]?.libelle ?? r.statut}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] text-slate-700 dark:text-zinc-300">{r.consigne}</p>
              {r.statut === "ACTIVE" && r.prochaineLe && <p className="mt-1 text-[12px] text-slate-500">Prochain passage : {quand(r.prochaineLe)}</p>}
              {r.echecsConsecutifs >= 2 && <p className="mt-1 text-[12px] text-red-600">{r.echecsConsecutifs} échecs d&apos;affilée — ouvrez le dernier passage pour la cause.</p>}

              {r.passages.length > 0 && (
                <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-zinc-800 dark:border-zinc-800">
                  {r.passages.slice(0, 5).map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => ouvrir(p.id)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-slate-50 dark:hover:bg-zinc-900">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${p.lu ? "bg-transparent" : "bg-violet-600"}`} aria-label={p.lu ? undefined : "Non lu"} />
                        <span className="shrink-0 text-[12px] text-slate-500">{quand(p.debutLe)}</span>
                        <span className={`shrink-0 text-[12px] font-medium ${p.statut === "ECHEC" ? "text-red-600" : "text-slate-700 dark:text-zinc-300"}`}>{PASSAGE[p.statut] ?? p.statut}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-slate-500">{p.apercu}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.statut !== "ENDED" && (
                  <button type="button" disabled={!!occupe} onClick={() => agir(`b${r.id}`, () => basculerMaRoutine(r.id, r.statut === "ACTIVE" ? "PAUSED" : "ACTIVE"))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900">
                    {r.statut === "ACTIVE" ? <><Pause className="h-3.5 w-3.5" /> Pause</> : <><Play className="h-3.5 w-3.5" /> Reprendre</>}
                  </button>
                )}
                <button type="button" disabled={!!occupe} onClick={() => agir(`x${r.id}`, () => executerMaRoutine(r.id))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900">
                  {occupe === `x${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />} Exécuter maintenant
                </button>
                <div className="flex-1" />
                {aSupprimer === r.id ? (
                  <>
                    <button type="button" disabled={!!occupe} onClick={async () => { await agir(`s${r.id}`, () => supprimerMaRoutine(r.id)); setASupprimer(null); }} className="h-9 rounded-lg bg-red-600 px-2.5 text-[12px] font-medium text-white disabled:opacity-60">Supprimer</button>
                    <button type="button" onClick={() => setASupprimer(null)} className="h-9 rounded-lg px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 dark:hover:bg-zinc-800">Annuler</button>
                  </>
                ) : (
                  <button type="button" aria-label="Supprimer la routine" onClick={() => setASupprimer(r.id)} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </PanneauLateral>
  );
}
