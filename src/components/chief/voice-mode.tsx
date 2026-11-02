"use client";

import * as React from "react";
import {
  Mic, MicOff, PhoneOff, Loader2, ChevronDown, ChevronUp, Minimize2, Maximize2,
  AudioLines, Keyboard, Send, ArrowUpRight,
} from "lucide-react";
import type { VoiceCallState } from "./realtime-voice";

/**
 * L'ÉCRAN D'APPEL — la peau du mode Live, entièrement pilotée par le CallProvider global
 * (components/layout/call-provider.tsx) : ce fichier ne contient AUCUNE logique de session.
 *
 * Deux formes :
 *   • IMMERSIF — plein écran sur mobile (safe areas, gros contrôles : marcher et parler),
 *     grande carte centrée sur desktop. En-tête « MY CHIEF OF STAFF · ● LIVE · 06:42 »,
 *     orbe à états, dernière réplique, CARTES LIVE cliquables (la voix résume, l'écran
 *     montre — ouvrir une carte RÉDUIT l'appel, il ne le coupe pas), TYPE (vrai champ de
 *     saisie dans l'appel), Mute, Raccrocher.
 *   • RÉDUIT — carte flottante discrète : l'appel continue pendant la navigation ERP.
 *
 * Sobre volontairement : pas de néons, pas de faux hologrammes — le « wow » vient de la
 * vitesse, du contexte et des cartes, pas des effets.
 */

const STATE_LABEL: Record<VoiceCallState, string> = {
  IDLE: "Prêt.",
  CONNECTING: "Connexion…",
  LISTENING: "Je vous écoute.",
  USER_SPEAKING: "Je vous entends…",
  THINKING: "Un instant…",
  ASSISTANT_SPEAKING: "Je vous réponds — parlez pour m'interrompre.",
  RECONNECTING: "Reconnexion…",
  ERROR: "Erreur de session.",
  ENDED: "Appel terminé.",
};

const fmt = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export interface CallScreenProps {
  status: VoiceCallState;
  elapsed: number;
  muted: boolean;
  minimized: boolean;
  error: string | null;
  lines: { role: "user" | "assistant"; text: string; final: boolean }[];
  cards: { label: string; href: string }[];
  onMute: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onEnd: () => void;
  onSendText: (text: string) => void;
  onOpenCard: (href: string) => void;
}

export function CallScreen({
  status, elapsed, muted, minimized, error, lines, cards,
  onMute, onMinimize, onRestore, onEnd, onSendText, onOpenCard,
}: CallScreenProps) {
  const [showTranscript, setShowTranscript] = React.useState(false);
  const [typing, setTyping] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const connected = status === "LISTENING" || status === "USER_SPEAKING" || status === "THINKING" || status === "ASSISTANT_SPEAKING";
  const busy = status === "CONNECTING" || status === "RECONNECTING";
  const label = error ?? (muted && connected ? "Micro coupé — il ne vous entend pas." : STATE_LABEL[status]);
  const lastLine = lines[lines.length - 1];

  const submitDraft = () => {
    const t = draft.trim();
    if (!t) return;
    onSendText(t);
    setDraft("");
  };

  // ── L'ORBE : sobre, un état à la fois.
  const orb = (
    <div className="relative flex h-28 w-28 items-center justify-center sm:h-24 sm:w-24">
      <div
        className={`absolute inset-0 rounded-full bg-gradient-to-br from-primary to-purple-500 transition-all duration-500 ${
          muted && connected ? "opacity-35 scale-90"
          : status === "ASSISTANT_SPEAKING" ? "opacity-90 scale-100"
          : status === "USER_SPEAKING" ? "opacity-80 scale-95"
          : status === "THINKING" ? "opacity-60 scale-90"
          : "opacity-70 scale-90"
        }`}
      />
      {(status === "LISTENING" || status === "USER_SPEAKING") && !muted && (
        <span aria-hidden className="absolute inset-0 animate-ping rounded-full border-2 border-primary/40" style={{ animationDuration: "2.2s" }} />
      )}
      {status === "ASSISTANT_SPEAKING" && (
        <span className="relative z-10 flex items-end gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="w-1.5 animate-pulse rounded-full bg-white/90" style={{ height: `${14 + (i % 2) * 10}px`, animationDelay: `${i * 140}ms`, animationDuration: "700ms" }} />
          ))}
        </span>
      )}
      {busy && <Loader2 className="relative z-10 h-8 w-8 animate-spin text-white" />}
      {connected && status !== "ASSISTANT_SPEAKING" && (
        muted ? <MicOff className="relative z-10 h-8 w-8 text-white/90" /> : <AudioLines className="relative z-10 h-8 w-8 text-white/95" />
      )}
    </div>
  );

  // ── RÉDUIT : carte flottante — l'appel continue partout dans l'ERP.
  if (minimized) {
    return (
      <div className="fixed inset-x-2 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[60] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80">
        <div className="flex items-center gap-3 rounded-2xl border border-primary/40 bg-card px-3 py-2.5 shadow-xl">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${status === "ASSISTANT_SPEAKING" ? "bg-primary animate-pulse" : status === "ERROR" ? "bg-destructive" : busy ? "bg-warning" : "bg-primary/70"}`} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold">Chief of Staff · {connected ? fmt(elapsed) : busy ? "…" : "—"}</p>
            <p className="truncate text-[0.6875rem] text-muted-foreground">{label}</p>
          </div>
          <button type="button" onClick={onMute} title={muted ? "Réactiver le micro" : "Couper le micro"}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition sm:h-8 sm:w-8 ${muted ? "bg-destructive/15 text-destructive" : "text-muted-foreground hover:bg-secondary"}`}>
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <button type="button" onClick={onRestore} title="Reprendre l'appel en grand"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-secondary sm:h-8 sm:w-8">
            <Maximize2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={onEnd} title="Raccrocher"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive transition hover:bg-destructive/20 sm:h-8 sm:w-8">
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // ── IMMERSIF : plein écran mobile, carte premium desktop.
  return (
    <div className="fixed inset-0 z-[60] flex sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="Appel avec My Chief of Staff">
      <button type="button" aria-label="Réduire l'appel" className="absolute inset-0 hidden bg-black/50 backdrop-blur-sm sm:block" onClick={onMinimize} />
      <div className="relative z-10 flex h-full w-full flex-col bg-card pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] sm:h-auto sm:max-h-[92dvh] sm:w-full sm:max-w-md sm:rounded-3xl sm:border sm:border-border sm:pb-6 sm:pt-6 sm:shadow-2xl">

        {/* En-tête : identité, ● LIVE réel (jamais affiché sans connexion), timer. */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-5">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-wide">MY CHIEF OF STAFF</p>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {connected ? (
                <>
                  <span className="flex items-center gap-1 font-medium text-primary"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> LIVE</span>
                  <span className="tabular-nums">{fmt(elapsed)}</span>
                </>
              ) : (
                <span>{status === "CONNECTING" ? "Connexion…" : status === "RECONNECTING" ? "Reconnexion…" : status === "ERROR" ? "Hors ligne" : "—"}</span>
              )}
            </p>
          </div>
          <button type="button" onClick={onMinimize} title="Réduire — l'appel continue (Échap)"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-secondary hover:text-foreground sm:h-9 sm:w-9">
            <Minimize2 className="h-4 w-4" />
          </button>
        </div>

        {/* Corps : orbe, état, dernière réplique — de l'air, pas de surcharge.
            Il défile quand le transcript, le champ et les cartes ne tiennent plus sur un petit
            téléphone ; `my-auto` (et non `justify-center`) garde le haut atteignable. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <div className="my-auto flex w-full flex-col items-center gap-4 px-5 py-4 sm:gap-5 sm:px-6 sm:py-6">
          {orb}
          <p className={`text-center text-sm [overflow-wrap:anywhere] ${error ? "text-destructive" : "text-muted-foreground"}`}>{label}</p>
          {!showTranscript && lastLine && !error && (
            <p className="line-clamp-2 w-full max-w-sm text-center text-xs text-muted-foreground/80 [overflow-wrap:anywhere]">
              {lastLine.role === "user" ? "Vous : " : ""}{lastLine.text}
            </p>
          )}
          {showTranscript && (
            <div className="max-h-[min(11rem,30dvh)] w-full space-y-1.5 overflow-y-auto overscroll-contain rounded-xl bg-secondary/50 p-3">
              {lines.length === 0 && <p className="text-xs text-muted-foreground">La conversation s&apos;affichera ici.</p>}
              {lines.map((l, i) => (
                <p key={i} className={`text-xs [overflow-wrap:anywhere] ${l.role === "user" ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {l.role === "user" ? "Vous — " : ""}{l.text}
                </p>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setShowTranscript((s) => !s)}
            className="flex min-h-9 items-center gap-1 rounded-lg px-3 text-[0.6875rem] text-muted-foreground transition hover:text-foreground sm:min-h-0 sm:px-0">
            {showTranscript ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
            {showTranscript ? "Masquer le transcript" : "Voir le transcript"}
          </button>
          {error && (
            <p className="w-full max-w-sm rounded-xl bg-secondary/60 px-3 py-2 text-center text-xs text-muted-foreground">
              La dictée reste disponible (icône micro du chat) — transcription simple, sans temps réel.
            </p>
          )}
        </div>
        </div>

        {/* CARTES LIVE : ce dont on parle s'affiche — toucher ouvre la fiche, l'appel se réduit. */}
        {cards.length > 0 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto overscroll-x-contain px-5 pb-3 [scrollbar-width:none]">
            {cards.map((c) => (
              <button
                key={c.href}
                type="button"
                onClick={() => onOpenCard(c.href)}
                className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-secondary/50 px-3 py-2 text-xs font-medium sm:min-h-0 transition hover:border-primary/50 hover:text-primary"
                title="Ouvrir — l'appel continue en réduit"
              >
                <span className="max-w-[11rem] truncate">{c.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}

        {/* TYPE : un vrai champ de saisie DANS l'appel — même conversation, réponse parlée. */}
        {typing && (
          <form
            onSubmit={(e) => { e.preventDefault(); submitDraft(); }}
            className="flex shrink-0 items-center gap-2 px-5 pb-3"
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Écrire au Chief of Staff…"
              enterKeyHint="send"
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3.5 text-base outline-none lg:text-sm transition placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
            <button type="submit" disabled={!draft.trim() || !connected}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition disabled:opacity-40">
              <Send className="h-4 w-4" />
            </button>
          </form>
        )}

        {/* Contrôles : gros, peu nombreux — mute / type / raccrocher. */}
        <div className="flex shrink-0 items-center justify-center gap-6 px-6 sm:gap-5">
          <button type="button" onClick={onMute} disabled={!connected}
            title={muted ? "Réactiver le micro" : "Couper le micro"}
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition disabled:opacity-40 ${
              muted ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-border text-foreground hover:bg-secondary"
            }`}>
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <button type="button" onClick={onEnd} title="Raccrocher"
            className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-lg transition hover:opacity-90">
            <PhoneOff className="h-6 w-6" />
          </button>
          <button type="button"
            onClick={() => { setTyping((t) => !t); setTimeout(() => inputRef.current?.focus(), 50); }}
            disabled={!connected}
            title="Écrire pendant l'appel"
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition disabled:opacity-40 ${
              typing ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-foreground hover:bg-secondary"
            }`}>
            <Keyboard className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
