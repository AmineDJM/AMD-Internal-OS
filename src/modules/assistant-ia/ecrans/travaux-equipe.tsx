"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Clock, Loader2, Users } from "lucide-react";
import { LIBELLE_ETAT } from "@/lib/missions/travaux/regles";
import { lireTravailDeMonEquipe, listerTravauxDeMonEquipe } from "../actions-travaux";

/**
 * LES TRAVAUX DE MON ÉQUIPE (J8, décision 0023) — visibles seulement si la console l'autorise (défaut : non).
 * Le résumé et les étapes ; ni carnet, ni journal, ni livrables. Chaque consultation est à l'audit — l'écran le dit.
 */

type Liste = Extract<Awaited<ReturnType<typeof listerTravauxDeMonEquipe>>, { ok: true }>;
type Travail = Liste["travaux"][number];
type Detail = Extract<Awaited<ReturnType<typeof lireTravailDeMonEquipe>>, { ok: true }>["travail"];

const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const STATUT_ETAPE: Record<string, string> = {
  PENDING: "À venir", READY: "Prête", RUNNING: "En cours", WAITING: "En attente", DONE: "Faite", FAILED: "Échec", SKIPPED: "Écartée", CANCELLED: "Annulée",
};

export function TravauxEquipe({ onVisible }: { onVisible?: (v: boolean) => void }) {
  const [liste, setListe] = useState<Liste | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const charger = useCallback(async () => {
    try {
      const r = await listerTravauxDeMonEquipe();
      if (r.ok) { setListe(r); onVisible?.(r.visible); } else setErreur(r.erreur);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    }
  }, [onVisible]);
  useEffect(() => { void charger(); }, [charger]);
  const ouvrir = async (id: string) => {
    try {
      const r = await lireTravailDeMonEquipe(id);
      if (r.ok) setDetail(r.travail); else setErreur(r.erreur);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    }
  };

  if (erreur) return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>;
  if (!liste) return <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>;
  if (!liste.visible) return <p className="py-6 text-center text-[13px] text-slate-500">La console de l&apos;Assistant IA ne permet pas aux responsables de voir les travaux de leur équipe.</p>;

  const resume = (t: Travail) => (
    <>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-100">{t.titre}</p>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">{LIBELLE_ETAT[t.etat]}</span>
      </div>
      <p className="mt-0.5 text-[12px] text-slate-600 dark:text-zinc-400">{t.personne}{t.priorite !== "NORMALE" ? ` · priorité ${t.priorite.toLowerCase()}` : ""}</p>
      {t.attente && <p className="mt-1 flex items-center gap-1 text-[12px] text-slate-600 dark:text-zinc-400"><Clock className="h-3.5 w-3.5" /> {t.attente}</p>}
      <p className="mt-1 text-[12px] text-slate-500">{t.etapes.faites}/{t.etapes.total} étapes{t.etapes.enEchec ? ` · ${t.etapes.enEchec} en échec` : ""} · {usd(t.coutUsd)}</p>
    </>
  );

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-[12px] text-slate-500"><Users className="h-3.5 w-3.5" /> Lecture seule : résumé et étapes. Chaque consultation est enregistrée à l&apos;audit.</p>
      {detail ? (
        <article className="space-y-3">
          <button type="button" onClick={() => setDetail(null)} className="inline-flex h-9 items-center gap-1 text-[12px] text-slate-600 dark:text-zinc-400"><ChevronLeft className="h-4 w-4" /> Retour à l&apos;équipe</button>
          {resume(detail)}
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-zinc-800 dark:border-zinc-800">
            {detail.liste.map((e) => (
              <li key={e.cle} className="flex items-center gap-2 px-2.5 py-2 text-[12px]">
                <span className="w-16 shrink-0 text-slate-500">{e.type}</span>
                <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-zinc-200">{e.titre}</span>
                <span className="shrink-0 text-slate-600 dark:text-zinc-400">{STATUT_ETAPE[e.statut] ?? e.statut}</span>
              </li>
            ))}
          </ul>
        </article>
      ) : liste.travaux.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-slate-500">Aucun travail en cours dans votre équipe.</p>
      ) : (
        <ul className="space-y-3">
          {liste.travaux.map((t) => (
            <li key={t.id} className="rounded-xl border border-slate-200 p-3 dark:border-zinc-800">
              <button type="button" onClick={() => ouvrir(t.id)} className="block w-full text-left">{resume(t)}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
