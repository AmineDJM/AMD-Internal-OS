"use client";

import * as React from "react";
import { EVENEMENT_NON_LUES } from "@/components/layout/notification-popup";
import { sansBloquer } from "@/lib/journal";

/**
 * Sonnerie de notification (rappels « Me rappeler », invitations, etc.) — sonde le nombre de
 * notifications non lues et, dès qu'il **augmente**, joue un petit **carillon sympa et pro** (arpège
 * doux, différent du « ding » de la messagerie) et, si l'app n'est pas au premier plan et que les
 * notifications sont autorisées, affiche une notification bureau. Le compteur vient du sondage de
 * `NotificationPopup` (événement `EVENEMENT_NON_LUES`), même en arrière-plan.
 */
let ctx: AudioContext | null = null;
let unlocked = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) ctx = new Ctx();
  return ctx;
}

/** Carillon à trois notes montantes (do–mi–sol), enveloppe douce. */
function playChime() {
  try {
    const ac = audio();
    if (!ac) return;
    if (ac.state === "suspended") ac.resume().catch(sansBloquer("notification-chime.playChime.resume"));
    const now = ac.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 – E5 – G5
    notes.forEach((freq, i) => {
      const t = now + i * 0.13;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  } catch {
    /* audio indisponible : on ignore */
  }
}

function desktop() {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const n = new Notification("Rappel — AMD Internal OS", { body: "Vous avez une nouvelle notification.", icon: "/icon.svg", badge: "/icon.svg", tag: "amd-reminder" });
    n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); window.location.href = "/notifications"; };
  } catch {
    /* ignore */
  }
}

export function NotificationChime({ initial }: { initial: number }) {
  const prev = React.useRef(initial);

  // Déblocage de l'audio au premier geste (politique d'autoplay).
  React.useEffect(() => {
    if (unlocked) return;
    const onGesture = () => { audio()?.resume().catch(sansBloquer("notification-chime.onGesture.resume")); unlocked = true; ["pointerdown", "keydown", "touchstart"].forEach((e) => window.removeEventListener(e, onGesture)); };
    ["pointerdown", "keydown", "touchstart"].forEach((e) => window.addEventListener(e, onGesture));
    return () => ["pointerdown", "keydown", "touchstart"].forEach((e) => window.removeEventListener(e, onGesture));
  }, []);

  // PAS DE SONDAGE PROPRE (audit performance, PERF-04) : la fenêtre pop-up sonde déjà
  // `/api/notifications/poll` et diffuse le compteur. Deux sondages de la même route, à 15 s et
  // 20 s, doublaient le coût — chaque appel résout la session et tous les droits.
  React.useEffect(() => {
    const onUnread = (e: Event) => {
      const unread = Number((e as CustomEvent<{ unread?: number }>).detail?.unread ?? 0);
      if (unread > prev.current) { playChime(); desktop(); }
      prev.current = unread;
    };
    window.addEventListener(EVENEMENT_NON_LUES, onUnread);
    return () => window.removeEventListener(EVENEMENT_NON_LUES, onUnread);
  }, []);

  return null;
}
