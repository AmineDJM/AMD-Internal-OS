"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Radar, ThumbsDown, ThumbsUp, X } from "lucide-react";
import {
  accorderMonMandat, ecarterConstat, jugerConstat, lireMaVeille, reglerMaVeille, reglerMonVeilleur, revoquerMonMandat,
} from "@/modules/assistant-ia/actions-proactivite";
import { PanneauLateral } from "./panneau-lateral";

/**
 * « CE QUE MON ASSISTANT SURVEILLE » (J12, décision 0024) — la veille de la personne, en quatre onglets :
 *   • Constats : ce que les veilleurs ont vu, comment c'est arrivé (interruption, point du matin, journal),
 *     et le retour en un clic « utile / pas utile » qui ajuste le veilleur ;
 *   • Veilleurs : activer, désactiver, régler le seuil de chacun ; son taux d'utilité ;
 *   • Mandats : les gestes confiés (bornes, échéance, ce qui a été fait), révoquer en un clic, en accorder un ;
 *   • Réglages : le budget d'interruptions et les heures calmes (heure d'Alger).
 */

type Veille = Extract<Awaited<ReturnType<typeof lireMaVeille>>, { ok: true }>["veille"];
type Onglet = "constats" | "veilleurs" | "mandats" | "reglages";

const GRAVITE: Record<string, string> = {
  URGENT: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
  ATTENTION: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  INFO: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400",
};
const CANAL: Record<string, string> = { INTERRUPTION: "Notifié", MATIN: "Point du matin", JOURNAL: "Au journal", DOSSIER: "Vu sur le dossier" };
const ETAT_MANDAT: Record<string, string> = { ACTIF: "Actif", EN_ATTENTE_CONSOLE: "En attente de la console", REVOQUE: "Révoqué", EXPIRE: "Échu" };
const UNITE: Record<string, string> = { jours: "jours", "%": "%", minutes: "min" };
const bouton = "inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900";
const jour = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });

export function VeillePanel({ ouvert, onFermer }: { ouvert: boolean; onFermer: () => void }) {
  const [veille, setVeille] = useState<Veille | null>(null);
  const [onglet, setOnglet] = useState<Onglet>("constats");
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const r = await lireMaVeille();
      if (r.ok) { setVeille(r.veille); setErreur(null); } else setErreur(r.erreur);
    } catch {
      setErreur("La veille n'a pas pu être chargée (connexion ou serveur).");
    }
  }, []);
  useEffect(() => { if (ouvert) void charger(); }, [ouvert, charger]);

  const agir = async (cle: string, f: () => Promise<{ ok: boolean; erreur?: string }>) => {
    setOccupe(cle);
    try {
      const r = await f();
      if (!r.ok) { setErreur(r.erreur ?? "Opération impossible."); return; }
      setErreur(null);
      await charger();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };

  if (!ouvert) return null;

  return (
    <PanneauLateral
      etiquette="Ma veille" titre="Ce que mon assistant surveille" icone={<Radar className="h-4 w-4 text-violet-600" />} onFermer={onFermer}
      pied={<>Les veilleurs sont des règles : le modèle ne décide pas de vous déranger. Au plus {veille?.preferences.interruptionsMax ?? 5} interruptions par jour, jamais aux heures calmes (heure d&apos;Alger, week-end vendredi-samedi).</>}
    >
      {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>}
      {veille?.coupee && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">La proactivité est coupée par la console : rien ne vous sera signalé ni fait sous mandat.</p>}

      <div role="tablist" className="flex gap-1 overflow-x-auto">
        {(["constats", "veilleurs", "mandats", "reglages"] as Onglet[]).map((o) => (
          <button key={o} role="tab" type="button" aria-selected={onglet === o} onClick={() => setOnglet(o)}
            className={`h-9 shrink-0 rounded-lg px-3 text-[13px] font-medium ${onglet === o ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}>
            {{ constats: "Constats", veilleurs: "Veilleurs", mandats: "Mandats", reglages: "Réglages" }[o]}
          </button>
        ))}
      </div>

      {veille === null ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : onglet === "constats" ? (
        <div className="space-y-3">
          <p className="text-[12px] text-slate-500">Aujourd&apos;hui : {veille.interruptionsAujourdhui} interruption(s) sur {veille.preferences.interruptionsMax}. Utilité : {veille.utilite.phrase}</p>
          {veille.signaux.length === 0 ? <p className="py-6 text-center text-[13px] text-slate-500">Rien à signaler pour l&apos;instant.</p> : (
            <ul className="space-y-2">
              {veille.signaux.map((s) => (
                <li key={s.id} className={`rounded-xl border border-slate-200 p-3 dark:border-zinc-800 ${s.etat === "RESOLU" || s.etat === "ECARTE" ? "opacity-60" : ""}`}>
                  <div className="flex items-start gap-2">
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${GRAVITE[s.gravite] ?? GRAVITE.INFO}`}>{s.veilleur}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-slate-500">{jour(s.detecteLe)}{s.canal ? ` · ${CANAL[s.canal] ?? s.canal}` : ""}{s.etat === "RESOLU" ? " · résolu" : ""}</span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-100">{s.titre}</p>
                  <p className="mt-0.5 text-[13px] text-slate-600 [overflow-wrap:anywhere] dark:text-zinc-400">{s.detail}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button type="button" disabled={!!occupe} aria-pressed={s.retour === "UTILE"} onClick={() => agir(`u${s.id}`, () => jugerConstat(s.id, "UTILE"))}
                      className={`${bouton} ${s.retour === "UTILE" ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" : ""}`}><ThumbsUp className="h-3.5 w-3.5" /> Utile</button>
                    <button type="button" disabled={!!occupe} aria-pressed={s.retour === "PAS_UTILE"} onClick={() => agir(`p${s.id}`, () => jugerConstat(s.id, "PAS_UTILE"))}
                      className={`${bouton} ${s.retour === "PAS_UTILE" ? "border-red-300 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400" : ""}`}><ThumbsDown className="h-3.5 w-3.5" /> Pas utile</button>
                    {s.lien && <a href={s.lien} className={bouton}><ExternalLink className="h-3.5 w-3.5" /> Ouvrir</a>}
                    {s.etat !== "RESOLU" && s.etat !== "ECARTE" && (
                      <button type="button" aria-label="Écarter ce constat" disabled={!!occupe} onClick={() => agir(`e${s.id}`, () => ecarterConstat(s.id))} className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800"><X className="h-3.5 w-3.5" /></button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : onglet === "veilleurs" ? (
        <ul className="space-y-2">
          {veille.veilleurs.map((v) => (
            <li key={v.code} className={`rounded-xl border border-slate-200 p-3 dark:border-zinc-800 ${v.ouvert ? "" : "opacity-60"}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{v.libelle} <span className="text-[11px] font-normal text-slate-500">· {v.pole}</span></p>
                  <p className="mt-0.5 text-[12px] text-slate-600 dark:text-zinc-400">{v.description}</p>
                </div>
                <label className="flex h-9 shrink-0 items-center gap-1.5 text-[12px] text-slate-700 dark:text-zinc-300">
                  <input type="checkbox" className="h-4 w-4" checked={v.actif && v.ouvert} disabled={!v.ouvert || !!occupe}
                    onChange={(e) => agir(`a${v.code}`, () => reglerMonVeilleur(v.code, e.target.checked, null))} />
                  Actif
                </label>
              </div>
              {v.ouvert ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-slate-600 dark:text-zinc-400">
                  <label className="flex items-center gap-1.5">Seuil
                    <input type="number" inputMode="numeric" min={v.min} max={v.max} defaultValue={v.seuil} disabled={!!occupe}
                      onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== v.seuil) void agir(`s${v.code}`, () => reglerMonVeilleur(v.code, null, n)); }}
                      className="h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-[13px] dark:border-zinc-800 dark:bg-zinc-950" />
                    {UNITE[v.unite]}
                  </label>
                  {v.seuilEffectif !== v.seuil && <span>appliqué : {v.seuilEffectif} {UNITE[v.unite]} (ajusté par vos retours)</span>}
                  <span className="w-full">{v.discret ? "Discret (journal seulement) — vos retours le jugent peu utile. " : ""}{v.utilite}</span>
                </div>
              ) : <p className="mt-1.5 text-[12px] text-slate-500">Non ouvert pour vous (droits de l&apos;écran ou famille de la console fermée).</p>}
            </li>
          ))}
        </ul>
      ) : onglet === "mandats" ? (
        <Mandats veille={veille} occupe={occupe} agir={agir} />
      ) : (
        <Reglages veille={veille} occupe={occupe} agir={agir} />
      )}
    </PanneauLateral>
  );
}

type Agir = (cle: string, f: () => Promise<{ ok: boolean; erreur?: string }>) => Promise<void>;

function Mandats({ veille, occupe, agir }: { veille: Veille; occupe: string | null; agir: Agir }) {
  const [capacite, setCapacite] = useState(veille.capacites[0]?.code ?? "");
  const [jours, setJours] = useState(30);
  const [gestes, setGestes] = useState(3);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-600 dark:text-zinc-400">
        Un mandat confie UN geste simple et réversible à votre assistant, sans carte à chaque fois : borné (nombre par jour, échéance), révocable à tout moment, tout est journalisé. Le geste se fait quand vous êtes connecté, avec vos droits du moment.
      </p>
      {veille.mandats.length === 0 ? <p className="text-[13px] text-slate-500">Aucun mandat.</p> : (
        <ul className="space-y-2">
          {veille.mandats.map((m) => (
            <li key={m.id} className="rounded-xl border border-slate-200 p-3 dark:border-zinc-800">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-sm font-semibold text-slate-900 dark:text-zinc-100">{m.libelle}</p>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">{ETAT_MANDAT[m.statut] ?? m.statut}</span>
              </div>
              <p className="mt-0.5 text-[12px] text-slate-600 dark:text-zinc-400">{m.gestesParJour} geste(s) par jour au plus · jusqu&apos;au {jour(m.expireLe)}</p>
              {m.gestes.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12px] text-slate-600 dark:text-zinc-400">
                  {m.gestes.map((g) => <li key={g.id}>{jour(g.faitLe)} · {g.statut === "FAIT" ? "Fait" : g.statut === "REFUSE" ? "Non fait" : g.statut === "ECHEC" ? "Échec" : "En cours"} — {g.resume}</li>)}
                </ul>
              )}
              {(m.statut === "ACTIF" || m.statut === "EN_ATTENTE_CONSOLE") && (
                <button type="button" disabled={!!occupe} onClick={() => agir(`r${m.id}`, () => revoquerMonMandat(m.id))} className={`${bouton} mt-2 text-red-700 dark:text-red-400`}>Révoquer</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {veille.capacites.length > 0 ? (
        <form className="space-y-2 rounded-xl border border-dashed border-slate-300 p-3 dark:border-zinc-700"
          onSubmit={(e) => { e.preventDefault(); void agir("nouveau", () => accorderMonMandat(capacite, jours, gestes, "")); }}>
          <p className="text-[13px] font-semibold text-slate-900 dark:text-zinc-100">Accorder un mandat</p>
          <select value={capacite} onChange={(e) => setCapacite(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-[13px] dark:border-zinc-800 dark:bg-zinc-950">
            {veille.capacites.map((c) => <option key={c.code} value={c.code}>{c.libelle}</option>)}
          </select>
          <p className="text-[12px] text-slate-500">{veille.capacites.find((c) => c.code === capacite)?.description}</p>
          <div className="flex flex-wrap gap-3 text-[12px] text-slate-600 dark:text-zinc-400">
            <label className="flex items-center gap-1.5">Durée
              <input type="number" min={1} max={90} value={jours} onChange={(e) => setJours(Number(e.target.value))} className="h-9 w-16 rounded-lg border border-slate-200 bg-white px-2 dark:border-zinc-800 dark:bg-zinc-950" /> jours
            </label>
            <label className="flex items-center gap-1.5">Au plus
              <input type="number" min={1} max={10} value={gestes} onChange={(e) => setGestes(Number(e.target.value))} className="h-9 w-16 rounded-lg border border-slate-200 bg-white px-2 dark:border-zinc-800 dark:bg-zinc-950" /> par jour
            </label>
          </div>
          <button type="submit" disabled={!!occupe || !capacite} className="h-9 rounded-lg bg-violet-600 px-3 text-[13px] font-medium text-white disabled:opacity-60">Accorder</button>
        </form>
      ) : <p className="text-[12px] text-slate-500">Aucun geste ne peut vous être confié pour l&apos;instant (droits de l&apos;écran, ou écritures fermées par la console).</p>}
    </div>
  );
}

function Reglages({ veille, occupe, agir }: { veille: Veille; occupe: string | null; agir: Agir }) {
  const [p, setP] = useState(veille.preferences);
  const heures = Array.from({ length: 24 }, (_, h) => h);
  const champ = "h-9 rounded-lg border border-slate-200 bg-white px-2 text-[13px] dark:border-zinc-800 dark:bg-zinc-950";
  return (
    <form className="space-y-3 text-[13px] text-slate-700 dark:text-zinc-300" onSubmit={(e) => { e.preventDefault(); void agir("prefs", () => reglerMaVeille(p.interruptionsMax, p.calmeDebut, p.calmeFin, p.weekendCalme, p.pointDuMatin)); }}>
      <label className="flex items-center justify-between gap-2">Interruptions par jour, au plus
        <select value={p.interruptionsMax} onChange={(e) => setP({ ...p, interruptionsMax: Number(e.target.value) })} className={champ}>
          {Array.from({ length: veille.plafondConsole + 1 }, (_, n) => n).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">Heures calmes (Alger)
        <span className="flex items-center gap-1.5">de
          <select aria-label="Début des heures calmes" value={p.calmeDebut} onChange={(e) => setP({ ...p, calmeDebut: Number(e.target.value) })} className={champ}>{heures.map((h) => <option key={h} value={h}>{h} h</option>)}</select>
          à
          <select aria-label="Fin des heures calmes" value={p.calmeFin} onChange={(e) => setP({ ...p, calmeFin: Number(e.target.value) })} className={champ}>{heures.map((h) => <option key={h} value={h}>{h} h</option>)}</select>
        </span>
      </div>
      <label className="flex h-9 items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={p.weekendCalme} onChange={(e) => setP({ ...p, weekendCalme: e.target.checked })} /> Week-end calme (vendredi, samedi)</label>
      <label className="flex h-9 items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={p.pointDuMatin} onChange={(e) => setP({ ...p, pointDuMatin: e.target.checked })} /> Point du matin (ce qui a attendu, ce qui a été fait sous mandat)</label>
      <button type="submit" disabled={!!occupe} className="h-9 rounded-lg bg-violet-600 px-3 text-[13px] font-medium text-white disabled:opacity-60">Enregistrer</button>
    </form>
  );
}
