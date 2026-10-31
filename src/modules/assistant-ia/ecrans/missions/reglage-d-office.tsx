"use client";

import React, { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import { lireMaPreferenceDOffice, reglerMaPreferenceDOffice } from "@/modules/assistant-ia/actions-travaux";
import { sansBloquer } from "@/lib/journal";

/**
 * « DÉMARRER D'OFFICE LES TRAVAUX SANS GESTE » (K3, décision 0033) — le réglage de la personne : un plan qui ne fait que
 * lire, analyser et déposer un livrable part sans clic ; tout geste reste approuvé. Défaut : celui de la console.
 */
export function ReglageDOffice({ compact = false }: { compact?: boolean }) {
  const [etat, setEtat] = useState<{ preference: boolean | null; effectif: boolean } | null>(null);
  const [avis, setAvis] = useState<string | null>(null);
  useEffect(() => {
    void lireMaPreferenceDOffice().then((r) => { if (r.ok) setEtat({ preference: r.preference, effectif: r.effectif }); }).catch(sansBloquer("reglage-d-office.lire"));
  }, []);
  if (!etat) return null;
  const changer = async (v: boolean) => {
    setEtat({ ...etat, preference: v, effectif: v });
    const r = await reglerMaPreferenceDOffice(v).catch(sansBloquer("reglage-d-office.regler", { ok: false as const, erreur: "Le réglage n'a pas été enregistré." }));
    setAvis(r.ok ? (v ? "Les plans sans geste démarreront d'office." : "Chaque plan attendra votre accord.") : r.erreur);
  };
  return (
    <div className="flex flex-col gap-1">
      <label className={`flex items-center gap-3 ${compact ? "text-[13px]" : "text-[14px]"}`}>
        <Rocket className="h-4 w-4 shrink-0 text-[var(--aia-discret)]" aria-hidden />
        <span className="flex-1">Démarrer d&apos;office les missions sans geste (lecture, analyse, livrable)</span>
        <input type="checkbox" checked={etat.effectif} onChange={(e) => void changer(e.target.checked)} data-testid="reglage-d-office"
          className="h-5 w-5 shrink-0 accent-[var(--aia-accent)]" />
      </label>
      <p className="pl-7 text-[12px] text-[var(--aia-discret)]">
        {avis ?? (etat.preference === null ? "Réglage par défaut de votre rôle. Un plan avec un geste, une demande ou une attente attend toujours votre accord." : "Un plan avec un geste, une demande ou une attente attend toujours votre accord.")}
      </p>
    </div>
  );
}
