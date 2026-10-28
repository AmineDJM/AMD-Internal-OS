"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Mic, SendHorizontal, Trash2 } from "lucide-react";
import { duree, DUREE_VOCAL_MAX_S } from "@/lib/agent/lecture/regles";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MICRO « COMME WHATSAPP » — un vocal part comme un MESSAGE du fil (Direction, 28/10/2026).
 *
 *   • MAINTENIR le bouton : ça enregistre ; RELÂCHER : le vocal part ; GLISSER VERS LA GAUCHE : il est
 *     annulé (rien n'est envoyé) ; GLISSER VERS LE HAUT : l'enregistrement se VERROUILLE (mains libres).
 *   • UN APPUI BREF : l'enregistrement démarre verrouillé — « Envoyer » ou la corbeille l'arrêtent.
 *   • Minuterie et onde EN DIRECT (niveau du micro) ; arrêt et envoi d'office à la durée maximale.
 *
 * Ce composant n'envoie rien lui-même : il rend l'enregistrement (`onVocal`) à l'écran, qui le dépose
 * dans le fil. Il n'importe que des règles pures (`lecture/regles.ts`, zéro import) : aucun module
 * serveur n'entre dans le navigateur. Distinct de la conversation temps réel (`voice-mode.tsx`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EnregistreurVocalProps {
  onVocal: (audio: Blob, dureeS: number) => void;
  desactive?: boolean;
}

type Phase = "repos" | "demarrage" | "maintenu" | "verrouille";

const SEUIL_ANNULER_PX = 90;
const SEUIL_VERROU_PX = 70;
const APPUI_BREF_MS = 280;
const BARRES = 36;

/** Le format que ce navigateur sait enregistrer — Opus/WebM (Chrome, Firefox, Android), sinon MP4 (Safari, iPhone). */
function formatEnregistrement(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return undefined;
}

export function EnregistreurVocal({ onVocal, desactive }: EnregistreurVocalProps) {
  const [phase, setPhase] = useState<Phase>("repos");
  const [secondes, setSecondes] = useState(0);
  const [niveaux, setNiveaux] = useState<number[]>(() => Array(BARRES).fill(0.08));
  const [decalage, setDecalage] = useState({ x: 0, y: 0 });
  const [erreur, setErreur] = useState<string | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const flux = useRef<MediaStream | null>(null);
  const morceaux = useRef<Blob[]>([]);
  const debut = useRef(0);
  const appuiLe = useRef(0);
  const origine = useRef({ x: 0, y: 0 });
  const annule = useRef(false);
  const relache = useRef(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const anim = useRef<number | null>(null);
  const minuteur = useRef<ReturnType<typeof setInterval> | null>(null);

  const nettoyer = useCallback(() => {
    if (anim.current) cancelAnimationFrame(anim.current);
    if (minuteur.current) clearInterval(minuteur.current);
    anim.current = null;
    minuteur.current = null;
    flux.current?.getTracks().forEach((t) => t.stop());
    flux.current = null;
    void audioCtx.current?.close().catch(sansBloquer("enregistreur-vocal.fermerAudio"));
    audioCtx.current = null;
    rec.current = null;
    setDecalage({ x: 0, y: 0 });
    setNiveaux(Array(BARRES).fill(0.08));
  }, []);

  useEffect(() => () => {
    annule.current = true;
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    nettoyer();
  }, [nettoyer]);

  /** Arrête : `envoyer` faux = le vocal est jeté, rien ne part. */
  const arreter = useCallback((envoyer: boolean) => {
    annule.current = !envoyer;
    const r = rec.current;
    if (r && r.state !== "inactive") r.stop();
    else { nettoyer(); setPhase("repos"); }
  }, [nettoyer]);

  const demarrer = useCallback(async (verrouille: boolean) => {
    setErreur(null);
    if (typeof window !== "undefined" && !window.isSecureContext) { setErreur("Le micro demande une connexion sécurisée (HTTPS)."); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setErreur("Ce navigateur n'enregistre pas l'audio."); return; }
    setPhase("demarrage");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      flux.current = stream;
      const mime = formatEnregistrement();
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      morceaux.current = [];
      annule.current = false;
      r.ondataavailable = (e) => { if (e.data.size) morceaux.current.push(e.data); };
      r.onstop = () => {
        const dureeS = Math.max(0, (Date.now() - debut.current) / 1000);
        const type = (r.mimeType || mime || "audio/webm").split(";")[0];
        const blob = new Blob(morceaux.current, { type });
        nettoyer();
        setPhase("repos");
        setSecondes(0);
        // Un vocal de moins d'une demi-seconde est un appui manqué, pas un message.
        if (!annule.current && dureeS >= 0.5 && blob.size > 0) onVocal(blob, Math.round(dureeS));
      };
      rec.current = r;
      r.start(250);
      debut.current = Date.now();
      setSecondes(0);
      minuteur.current = setInterval(() => {
        const s = (Date.now() - debut.current) / 1000;
        setSecondes(s);
        if (s >= DUREE_VOCAL_MAX_S) arreter(true);
      }, 200);

      // L'ONDE EN DIRECT : le niveau du micro, une barre toutes les ~90 ms.
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          audioCtx.current = ctx;
          const analyse = ctx.createAnalyser();
          analyse.fftSize = 512;
          ctx.createMediaStreamSource(stream).connect(analyse);
          const donnees = new Uint8Array(analyse.fftSize);
          let dernier = 0;
          const tic = (t: number) => {
            if (t - dernier > 90) {
              dernier = t;
              analyse.getByteTimeDomainData(donnees);
              let somme = 0;
              for (const v of donnees) somme += ((v - 128) / 128) ** 2;
              const n = Math.min(1, Math.sqrt(somme / donnees.length) * 4);
              setNiveaux((prev) => [...prev.slice(1), Math.max(0.08, n)]);
            }
            anim.current = requestAnimationFrame(tic);
          };
          anim.current = requestAnimationFrame(tic);
        }
      } catch { /* l'onde est un confort : sans elle, l'enregistrement continue */ }

      // Relâché pendant que le micro s'ouvrait (permission) : c'était un appui bref → verrouillé.
      setPhase(verrouille || relache.current ? "verrouille" : "maintenu");
    } catch {
      nettoyer();
      setPhase("repos");
      setErreur("Micro inaccessible — autorisez-le dans le navigateur.");
    }
  }, [arreter, nettoyer, onVocal]);

  const surAppui = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (desactive || phase !== "repos") return;
    e.preventDefault();
    (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
    appuiLe.current = Date.now();
    origine.current = { x: e.clientX, y: e.clientY };
    relache.current = false;
    void demarrer(false);
  };

  const surDeplacement = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (phase !== "maintenu") return;
    const x = Math.min(0, e.clientX - origine.current.x);
    const y = Math.min(0, e.clientY - origine.current.y);
    setDecalage({ x, y });
    if (-x > SEUIL_ANNULER_PX) arreter(false);
    else if (-y > SEUIL_VERROU_PX) { setPhase("verrouille"); setDecalage({ x: 0, y: 0 }); }
  };

  const surRelache = () => {
    relache.current = true;
    if (phase === "maintenu") {
      // Un appui BREF ne fait pas un vocal : il démarre l'enregistrement verrouillé.
      if (Date.now() - appuiLe.current < APPUI_BREF_MS) { setPhase("verrouille"); setDecalage({ x: 0, y: 0 }); return; }
      arreter(true);
    }
  };

  const enCours = phase === "maintenu" || phase === "verrouille";

  return (
    <>
      {enCours && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 z-30 flex items-center gap-2 rounded-2xl bg-white/98 px-2 dark:bg-zinc-950/98"
          style={phase === "maintenu" ? { transform: `translateX(${Math.max(decalage.x, -SEUIL_ANNULER_PX) / 3}px)` } : undefined}
        >
          {phase === "verrouille" ? (
            <button type="button" onClick={() => arreter(false)} aria-label="Annuler le vocal" title="Annuler"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40">
              <Trash2 className="h-4 w-4" />
            </button>
          ) : (
            <span className="ml-2 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-600" aria-hidden />
          )}
          <span className="w-11 shrink-0 font-mono text-sm tabular-nums text-slate-800 dark:text-zinc-100" aria-label={`Durée ${duree(secondes)}`}>{duree(secondes)}</span>
          <div className="flex h-8 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden>
            {niveaux.map((n, i) => (
              <span key={i} className="w-[3px] shrink-0 rounded-full bg-red-500/80 transition-[height] duration-75" style={{ height: `${Math.round(n * 100)}%` }} />
            ))}
          </div>
          {phase === "maintenu" ? (
            <span className="shrink-0 select-none pr-12 text-[11px] text-slate-500 dark:text-zinc-400">
              <span className="hidden min-[380px]:inline">‹ glisser pour annuler · </span>↑ <Lock className="inline h-3 w-3" />
            </span>
          ) : (
            <button type="button" onClick={() => arreter(true)} aria-label="Envoyer le vocal" title="Envoyer"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-2xs hover:bg-emerald-700">
              <SendHorizontal className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {erreur && !enCours && (
        <p role="alert" className="absolute -top-7 right-0 z-30 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700 shadow-2xs dark:bg-red-950/60 dark:text-red-300">{erreur}</p>
      )}
      <button
        type="button"
        disabled={desactive}
        onPointerDown={surAppui}
        onPointerMove={surDeplacement}
        onPointerUp={surRelache}
        onPointerCancel={() => { if (phase === "maintenu") arreter(false); }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && phase === "repos") { e.preventDefault(); void demarrer(true); } }}
        aria-label="Message vocal — maintenir pour enregistrer, ou appuyer pour démarrer"
        title="Message vocal — maintenir pour enregistrer (glisser à gauche pour annuler), ou appuyer pour démarrer"
        className={`relative z-40 flex h-10 w-10 shrink-0 touch-none select-none items-center justify-center rounded-xl shadow-2xs transition disabled:opacity-30 ${
          phase === "maintenu" ? "scale-125 bg-red-600 text-white" : phase === "verrouille" ? "hidden" : "bg-slate-900 text-white hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900"
        }`}
        style={phase === "maintenu" ? { transform: `translate(${decalage.x}px, ${decalage.y}px) scale(1.25)` } : undefined}
      >
        <Mic className="h-4 w-4" />
      </button>
    </>
  );
}
