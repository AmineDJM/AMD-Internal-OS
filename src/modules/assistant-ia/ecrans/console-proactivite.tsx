"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Radar } from "lucide-react";
import { actionFailureMessage } from "@/lib/action-outcome";
import {
  approuverMandatConsole, lireConsoleProactivite, reglerConsoleProactivite, revoquerMandatConsole,
} from "@/modules/assistant-ia/actions-proactivite";

/**
 * LA CONSOLE DE LA PROACTIVITÉ (J12, décision 0024) — Super Admin, page `/admin/ai/acces`.
 * Le plafond d'interruptions par personne et par jour, l'interrupteur général, la mesure (utilité des
 * constats, interruptions réelles), et les mandats en cours : accorder ceux qui attendent la console
 * (famille sensible, geste au-delà de R1), révoquer n'importe lequel.
 */
type Etat = Extract<Awaited<ReturnType<typeof lireConsoleProactivite>>, { ok: true }>;
const STATUT: Record<string, string> = { ACTIF: "Actif", EN_ATTENTE_CONSOLE: "Attend votre accord" };

export function ConsoleProactivite() {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [max, setMax] = useState(5);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const charger = useCallback(async () => {
    try {
      const r = await lireConsoleProactivite();
      if (r.ok) { setEtat(r); setMax(r.reglages.interruptionsMaxJour); } else setErreur(r.erreur);
    } catch { setErreur(actionFailureMessage("THROWN")); }
  }, []);
  useEffect(() => { void charger(); }, [charger]);
  const agir = async (f: () => Promise<{ ok: boolean; erreur?: string }>) => {
    setOccupe(true);
    try { const r = await f(); if (!r.ok) setErreur(r.erreur ?? "Opération impossible."); else { setErreur(null); await charger(); } }
    catch { setErreur(actionFailureMessage("THROWN")); }
    finally { setOccupe(false); }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Radar className="h-5 w-5 text-primary" /> Proactivité — veilleurs et mandats</h2>
      {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>}
      {!etat ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</p> : (
        <>
          <p className="text-sm text-muted-foreground">
            7 derniers jours : {etat.mesure.utilite} {etat.mesure.personnes} personne(s) prévenue(s), {etat.mesure.interruptionsParPersonneJour} interruption(s) par personne et par jour en moyenne.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">Interruptions par personne et par jour, au plus
              <input type="number" min={0} max={20} value={max} onChange={(e) => setMax(Number(e.target.value))} className="h-9 w-20 rounded-lg border border-border bg-background px-2" />
            </label>
            <button type="button" disabled={occupe} onClick={() => agir(() => reglerConsoleProactivite(max, null))} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60">Enregistrer</button>
            <button type="button" disabled={occupe} onClick={() => agir(() => reglerConsoleProactivite(null, !etat.reglages.coupee))}
              className={`h-9 rounded-lg border px-3 text-sm font-medium disabled:opacity-60 ${etat.reglages.coupee ? "border-emerald-300 text-emerald-700" : "border-red-300 text-red-700"}`}>
              {etat.reglages.coupee ? "Rallumer la proactivité" : "Couper toute la proactivité"}
            </button>
          </div>
          {etat.mesure.mandats.length === 0 ? <p className="text-sm text-muted-foreground">Aucun mandat en cours.</p> : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {etat.mesure.mandats.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">{m.libelle} — {m.gestesParJour}/jour, jusqu&apos;au {m.expireLe.slice(0, 10)} · {STATUT[m.statut] ?? m.statut}</span>
                  {m.statut === "EN_ATTENTE_CONSOLE" && <button type="button" disabled={occupe} onClick={() => agir(() => approuverMandatConsole(m.id))} className="h-9 rounded-lg border border-border px-2.5 text-[13px]">Accorder</button>}
                  <button type="button" disabled={occupe} onClick={() => agir(() => revoquerMandatConsole(m.id))} className="h-9 rounded-lg border border-red-300 px-2.5 text-[13px] text-red-700">Révoquer</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
