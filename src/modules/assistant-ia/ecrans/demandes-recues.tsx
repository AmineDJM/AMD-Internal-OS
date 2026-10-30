"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useState } from "react";
import { Clock, FileText, Inbox, Loader2, Paperclip, Send, Sparkles, X } from "lucide-react";
import { DriveExplorerSheet, type DrivePickerValue } from "@/components/drive/drive-picker";
import { declinerMaDemande, listerMesDemandesRecues, repondreAMaDemande } from "../actions-travaux";

/**
 * LES DEMANDES REÇUES (J8, décision 0023) — ce que les travaux de collègues demandent à la personne.
 *
 * Chaque carte : qui demande, la question, les pièces attendues, les pièces qu'on lui a partagées, l'échéance.
 * RIEN d'autre du travail de l'autre (ni son carnet, ni son plan). Elle répond ici — un texte, des pièces de SON
 * Drive (partagées en lecture avec le demandeur) — ou décline avec un motif ; « Préparer avec l'assistant » ouvre
 * la conversation sur la demande : SON assistant l'aide, avec SES droits, et la réponse reste son geste.
 */

type Liste = Extract<Awaited<ReturnType<typeof listerMesDemandesRecues>>, { ok: true }>;
type Demande = Liste["demandes"][number];

const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Africa/Algiers" });
const STATUT: Record<string, string> = { OUVERTE: "À répondre", REPONDUE: "Répondue", DECLINEE: "Déclinée", EXPIREE: "Expirée", ANNULEE: "Retirée" };

function Carte({ d, onFait, onPreparer, ouverte }: { d: Demande; onFait: (message: string) => void; onPreparer?: (texte: string) => void; ouverte: boolean }) {
  const [texte, setTexte] = useState("");
  const [pieces, setPieces] = useState<DrivePickerValue[]>([]);
  const [choisir, setChoisir] = useState(false);
  const [decliner, setDecliner] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const agir = async (f: () => Promise<{ ok: boolean; erreur?: string; message?: string }>) => {
    setOccupe(true);
    try {
      const r = await f();
      if (!r.ok) setErreur(r.erreur ?? "Opération impossible.");
      else { setErreur(null); onFait(r.message ?? "C'est fait."); }
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(false);
    }
  };
  const close = d.statut !== "OUVERTE";
  return (
    <li id={`demande-${d.id}`} className={`rounded-xl border p-3 ${ouverte ? "border-violet-400 dark:border-violet-700" : "border-slate-200 dark:border-zinc-800"}`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-slate-500 dark:text-zinc-400"><span className="font-semibold text-slate-900 dark:text-zinc-100">{d.de}</span> vous demande</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${close ? "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400" : d.enRetard ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400" : "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"}`}>
          {d.enRetard && !close ? "En retard" : STATUT[d.statut] ?? d.statut}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-100">{d.question}</p>
      <p className="mt-1 flex items-center gap-1 text-[12px] text-slate-600 dark:text-zinc-400"><Clock className="h-3.5 w-3.5" /> Réponse attendue avant le {jour(d.echeance)}</p>
      {d.piecesAttendues.length > 0 && <p className="mt-1 text-[12px] text-slate-600 dark:text-zinc-400">Pièces attendues : {d.piecesAttendues.join(", ")}</p>}
      {d.piecesPartagees.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[12px]">
          {d.piecesPartagees.map((p) => (
            <li key={p.nodeId}><a href={`/drive/${p.nodeId}`} className="inline-flex items-center gap-1 text-violet-700 underline dark:text-violet-300"><FileText className="h-3.5 w-3.5" />{p.nom}</a></li>
          ))}
        </ul>
      )}
      {close && d.reponse && <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[12px] text-slate-700 dark:bg-zinc-900 dark:text-zinc-300">Votre réponse : {d.reponse}</p>}

      {!close && (
        <div className="mt-2 space-y-2">
          <label className="sr-only" htmlFor={`rep-${d.id}`}>Votre réponse</label>
          <textarea
            id={`rep-${d.id}`} value={texte} onChange={(e) => setTexte(e.target.value)} rows={3} maxLength={8000}
            placeholder={decliner ? "Pourquoi vous ne pouvez pas répondre (une phrase)…" : "Votre réponse…"}
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
          {!decliner && pieces.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {pieces.map((p) => (
                <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[12px] dark:bg-zinc-800">
                  {p.name}
                  <button type="button" aria-label={`Retirer ${p.name}`} onClick={() => setPieces((x) => x.filter((y) => y.id !== p.id))} className="p-1"><X className="h-3 w-3" /></button>
                </li>
              ))}
            </ul>
          )}
          {erreur && <p role="alert" className="text-[12px] text-red-600">{erreur}</p>}
          <div className="flex flex-wrap gap-1.5">
            {decliner ? (
              <>
                <button type="button" disabled={occupe} onClick={() => agir(() => declinerMaDemande(d.id, texte))} className="inline-flex h-9 items-center gap-1 rounded-lg bg-slate-700 px-3 text-[12px] font-semibold text-white disabled:opacity-60">Décliner</button>
                <button type="button" onClick={() => setDecliner(false)} className="h-9 rounded-lg px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 dark:hover:bg-zinc-800">Retour</button>
              </>
            ) : (
              <>
                <button type="button" disabled={occupe} onClick={() => agir(() => repondreAMaDemande(d.id, texte, pieces.map((p) => p.id)))} className="inline-flex h-9 items-center gap-1 rounded-lg bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                  {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Envoyer la réponse
                </button>
                <button type="button" onClick={() => setChoisir(true)} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[12px] dark:border-zinc-800"><Paperclip className="h-3.5 w-3.5" /> Joindre du Drive</button>
                {onPreparer && (
                  <button type="button" onClick={() => onPreparer(`Aide-moi à répondre à la demande de ${d.de} (demande ${d.id}) : « ${d.question.slice(0, 300)} ». Cherche ce qu'il faut dans mes documents, puis prépare la réponse.`)} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[12px] dark:border-zinc-800">
                    <Sparkles className="h-3.5 w-3.5" /> Préparer avec l&apos;assistant
                  </button>
                )}
                <div className="flex-1" />
                <button type="button" onClick={() => setDecliner(true)} className="h-9 rounded-lg px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800">Je ne peux pas</button>
              </>
            )}
          </div>
        </div>
      )}
      {choisir && <DriveExplorerSheet onClose={() => setChoisir(false)} onPick={(v) => { setChoisir(false); if (!v.isFolder) setPieces((x) => (x.some((y) => y.id === v.id) ? x : [...x, v].slice(0, 10))); }} />}
    </li>
  );
}

export function DemandesRecues({ demandeInitiale, onPreparer, onOuvertes }: {
  demandeInitiale?: string | null; onPreparer?: (texte: string) => void; onOuvertes?: (n: number) => void;
}) {
  const [demandes, setDemandes] = useState<Demande[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const charger = useCallback(async () => {
    try {
      const r = await listerMesDemandesRecues();
      if (r.ok) { setDemandes(r.demandes); setErreur(null); onOuvertes?.(r.ouvertes); } else setErreur(r.erreur);
    } catch {
      setErreur("Les demandes n'ont pas pu être chargées (connexion ou serveur).");
    }
  }, [onOuvertes]);
  useEffect(() => { void charger(); }, [charger]);
  useEffect(() => {
    if (!demandeInitiale || !demandes) return;
    document.getElementById(`demande-${demandeInitiale}`)?.scrollIntoView({ block: "center" });
  }, [demandeInitiale, demandes]);

  if (erreur) return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>;
  if (demandes === null) return <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>;
  return (
    <div className="space-y-3">
      {info && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{info}</p>}
      {demandes.length === 0 ? (
        <div className="space-y-2 py-6 text-center text-[13px] text-slate-500">
          <Inbox className="mx-auto h-5 w-5" />
          <p>Aucune demande reçue. Quand le travail d&apos;un collègue a besoin de vous (une information, une pièce), sa demande arrive ici.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {demandes.map((d) => <Carte key={d.id} d={d} ouverte={d.id === demandeInitiale} onPreparer={onPreparer} onFait={(m) => { setInfo(m); void charger(); }} />)}
        </ul>
      )}
    </div>
  );
}
