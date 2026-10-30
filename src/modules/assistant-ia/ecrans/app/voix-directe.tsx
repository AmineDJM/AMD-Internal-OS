"use client";

import React, { useEffect, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { attendu } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONVERSATION VOCALE EN DIRECT (décision 0027, point 7b) — `gpt-live-1` UNIQUEMENT.
 *
 * L'écran (le « voile » de la maquette : onde qui respire, « Je vous écoute… », couper le micro, terminer) et le POINT
 * D'ACCROCHE serveur `/api/assistant-ia/voix-directe` : la session temps réel (secret éphémère, WebRTC, outils sous
 * les droits, transcription écrite dans la conversation) est le travail du lot J13 (`jarvis/j13-terrain-voix`).
 * Tant qu'il n'est pas sur la base, la route répond 501 et l'écran le DIT — il ne simule rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function VoixDirecte({ conversation, onFermer }: { conversation: string | null; onFermer: () => void }) {
  const [etat, setEtat] = useState<"connexion" | "ecoute" | "indisponible">("connexion");
  const [message, setMessage] = useState<string | null>(null);
  const [micCoupe, setMicCoupe] = useState(false);

  useEffect(() => {
    let annule = false;
    void (async () => {
      try {
        const r = await fetch("/api/assistant-ia/voix-directe", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation }),
        });
        const j = (await r.json().catch(attendu("corps vide : l'état HTTP suffit", {}))) as { error?: string };
        if (annule) return;
        if (!r.ok) { setEtat("indisponible"); setMessage(j.error ?? "La conversation vocale en direct est indisponible."); return; }
        // La session temps réel du lot J13 se branche ici (WebRTC vers gpt-live-1, transcription dans le fil).
        setEtat("ecoute");
      } catch {
        if (!annule) { setEtat("indisponible"); setMessage("Connexion impossible. Vérifiez le réseau."); }
      }
    })();
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") onFermer(); };
    window.addEventListener("keydown", echap);
    return () => { annule = true; window.removeEventListener("keydown", echap); };
  }, [conversation, onFermer]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Conversation vocale" data-testid="voix-directe"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-[var(--aia-panneau)] p-6 text-center text-[var(--aia-texte)]">
      <div aria-hidden className={`h-36 w-36 rounded-full ${etat === "ecoute" ? "aia-onde" : "opacity-50"}`}
        style={{ background: "radial-gradient(circle, var(--aia-voix) 0 30%, #57c8dd 31% 42%, var(--aia-voix-doux) 43% 100%)" }} />
      <p className="text-[22px] font-semibold">{etat === "connexion" ? "Connexion…" : etat === "ecoute" ? (micCoupe ? "Micro coupé" : "Je vous écoute…") : "Pas encore disponible"}</p>
      {message && <p className="max-w-md text-[14px] text-[var(--aia-discret)]" role="status">{message}</p>}
      <div className="flex gap-3">
        {etat === "ecoute" && (
          <button type="button" onClick={() => setMicCoupe((m) => !m)} aria-pressed={micCoupe}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--aia-accent)] px-4 py-2.5 text-[14px] text-[var(--aia-accent)]">
            {micCoupe ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />} {micCoupe ? "Rétablir le micro" : "Couper le micro"}
          </button>
        )}
        <button type="button" autoFocus onClick={onFermer} className="rounded-xl bg-[var(--aia-accent)] px-5 py-2.5 text-[14px] font-medium text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)]">
          {etat === "indisponible" ? "Fermer" : "Terminer"}
        </button>
      </div>
      <p className="max-w-md text-[12.5px] text-[var(--aia-discret)]">gpt-live-1 · la conversation s&apos;écrit dans ce fil · un geste important se confirme à l&apos;écran</p>
    </div>
  );
}
