"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { sansBloquer } from "@/lib/journal";

interface Geo { lat: number; lng: number; acc: number }

/** Envoie un relevé d'activité : temps RÉEL au premier plan, géoloc et appareil. */
function send(path: string, durationMs: number, geo: Geo | null, dev: string | null) {
  if (durationMs < 1000) return; // ignore le bruit (< 1 s)
  try {
    const data = JSON.stringify({ path, durationMs, lat: geo?.lat, lng: geo?.lng, accuracy: geo?.acc, dev });
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/activity", new Blob([data], { type: "text/plain" }));
    } else {
      fetch("/api/activity", { method: "POST", body: data, keepalive: true });
    }
  } catch {
    /* best-effort */
  }
}

type UAData = { getHighEntropyValues?: (h: string[]) => Promise<{ platform?: string; model?: string }> };

// Inactivité : le compteur tourne tant qu'il y a une interaction (souris, clavier,
// défilement, tactile) ; il se met en pause après 10 min SANS le moindre mouvement,
// et reprend dès que ça rebouge. (Le temps hors premier plan n'est jamais compté.)
const IDLE_MS = 600_000;
// Cadence de mesure (settle de l'accumulateur + détection d'inactivité) et de flush.
const TICK_MS = 10_000;
const FLUSH_MS = 120_000;

/**
 * Mesure le temps **réellement engagé** sur chaque page : on ne compte que lorsque
 * l'onglet est au PREMIER PLAN — c'est-à-dire **visible** (Page Visibility), **focalisé**
 * (`document.hasFocus()`) ET **non inactif** (interaction < 60 s). Le temps en arrière-plan,
 * onglet masqué ou fenêtre non focalisée n'est jamais comptabilisé. Alimente le score
 * d'adoption (dimension « Temps d'activité ») de façon précise et difficile à truquer.
 */
export function ActivityTracker() {
  const pathname = usePathname();
  const geoRef = React.useRef<Geo | null>(null);
  const devRef = React.useRef<string | null>(null);

  // Accumulateur de temps actif pour la page courante.
  const pathRef = React.useRef(pathname);
  const activeMs = React.useRef(0);
  const activeSince = React.useRef<number | null>(null);
  const lastInput = React.useRef(Date.now());

  // Géoloc précise (consentie) + appareil haute entropie, une fois.
  React.useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => { geoRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }; },
        () => { /* refusé → géoloc IP en repli */ },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
      );
    }
    const uad = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
    uad?.getHighEntropyValues?.(["model", "platform"]).then((v) => {
      devRef.current = [v.platform, v.model].filter(Boolean).join(" ").trim() || null;
    }).catch(sansBloquer("activity-tracker.ActivityTracker.getHighEntropyValues"));
  }, []);

  React.useEffect(() => {
    const isActive = () =>
      document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput.current < IDLE_MS;

    const pause = () => {
      if (activeSince.current !== null) {
        activeMs.current += Date.now() - activeSince.current;
        activeSince.current = null;
      }
    };
    const resume = () => {
      if (activeSince.current === null && isActive()) activeSince.current = Date.now();
    };
    const settle = () => { pause(); resume(); };

    const flush = (path: string) => {
      pause();
      const ms = activeMs.current;
      activeMs.current = 0;
      if (ms >= 1000) send(path, ms, geoRef.current, devRef.current);
      resume();
    };

    // Démarre la mesure pour la page courante.
    pathRef.current = pathname;
    activeMs.current = 0;
    activeSince.current = null;
    lastInput.current = Date.now();
    resume();

    const onInput = () => { lastInput.current = Date.now(); resume(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(pathRef.current); else settle(); };
    const onFocus = () => settle();
    const onBlur = () => pause();
    const onPageHide = () => flush(pathRef.current);

    const inputs: (keyof DocumentEventMap)[] = ["pointerdown", "keydown", "scroll", "touchstart", "mousemove", "wheel"];
    inputs.forEach((e) => document.addEventListener(e, onInput, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);

    // Battement : settle l'accumulateur (détecte l'inactivité) et flush périodiquement.
    let sinceFlush = 0;
    const timer = window.setInterval(() => {
      settle();
      sinceFlush += TICK_MS;
      if (sinceFlush >= FLUSH_MS) { flush(pathRef.current); sinceFlush = 0; }
    }, TICK_MS);

    return () => {
      flush(pathRef.current); // flush du temps de la page qu'on quitte
      window.clearInterval(timer);
      inputs.forEach((e) => document.removeEventListener(e, onInput));
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    };
  }, [pathname]);

  return null;
}
