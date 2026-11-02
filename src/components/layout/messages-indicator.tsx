"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { sansBloquer } from "@/lib/journal";

// ─── Son de notification (généré à la volée, sans fichier audio) ───
let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

/**
 * Débloque l'audio au premier geste utilisateur (politique d'autoplay des
 * navigateurs). Une fois débloqué, le son peut être joué même quand l'onglet est
 * en arrière-plan (l'utilisateur est sur un autre site).
 */
function unlockAudio() {
  const ctx = getCtx();
  if (!ctx) return;
  ctx.resume().catch(sansBloquer("messages-indicator.unlockAudio.resume"));
  try {
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* ignore */
  }
  audioUnlocked = true;
}

/**
 * Notification SUR L'ORDINATEUR (API Notification du navigateur) pour un nouveau message.
 * Ne s'affiche que si l'utilisateur a autorisé les notifications (bouton « Activer les
 * notifications » dans /notifications) ET que l'application n'est PAS au premier plan
 * (sinon la pastille + le son suffisent, inutile de le distraire). Fonctionne tant que
 * l'onglet est ouvert, même en arrière-plan ou sur un autre site. Clic → revient sur la
 * messagerie. Best-effort : toute indisponibilité est ignorée (le son a déjà retenti).
 */
function notifyDesktop(delta: number) {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    // Pas de notification si l'utilisateur regarde déjà l'appli (au premier plan ET focalisée).
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const body = delta > 1 ? `Vous avez ${delta} nouveaux messages.` : "Vous avez reçu un nouveau message.";
    const n = new Notification("Nouveau message — AMD Internal OS", {
      body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "amd-message", // remplace la précédente au lieu d'empiler
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      n.close();
      window.location.href = "/messages";
    };
  } catch {
    /* notifications indisponibles : on ignore */
  }
}

/** Joue un petit « ding » à deux tons quand un nouveau message arrive. */
function playPing() {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(sansBloquer("messages-indicator.playPing.resume"));
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    gain.connect(ctx.destination);
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      osc.connect(gain);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.2);
    });
  } catch {
    /* audio indisponible : on ignore */
  }
}

/**
 * Indicateur de messages non lus dans la topbar. Source unique de polling pour
 * le badge global : interroge /api/messaging/sync, diffuse le total via un
 * évènement `amd:messaging-unread` (écouté par la sidebar), et se met à jour
 * instantanément quand la messagerie ouverte émet ce même évènement. Ne poll pas
 * sur la page /messages (le Messenger pilote déjà la valeur). Le polling continue
 * en arrière-plan pour que le son retentisse même si l'onglet n'est pas au premier plan.
 */
export function MessagesIndicator({ initial }: { initial: number }) {
  const [count, setCount] = React.useState(initial);
  const prevCount = React.useRef(initial);
  const pathname = usePathname();
  const onMessagesPage = pathname.startsWith("/messages");

  // Déblocage de l'audio au tout premier geste de l'utilisateur sur la page.
  React.useEffect(() => {
    if (audioUnlocked) return;
    const onGesture = () => {
      unlockAudio();
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("touchstart", onGesture);
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    window.addEventListener("touchstart", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("touchstart", onGesture);
    };
  }, []);

  // Son + notification bureau dès que le total de non-lus augmente (nouveau message reçu).
  React.useEffect(() => {
    if (count > prevCount.current) {
      playPing();
      notifyDesktop(count - prevCount.current);
    }
    prevCount.current = count;
  }, [count]);

  React.useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ total: number }>).detail;
      if (detail && typeof detail.total === "number") setCount(detail.total);
    };
    window.addEventListener("amd:messaging-unread", onEvent);
    return () => window.removeEventListener("amd:messaging-unread", onEvent);
  }, []);

  React.useEffect(() => {
    if (onMessagesPage) return; // le Messenger gère la valeur via l'évènement
    let alive = true;
    // On poll AUSSI quand l'onglet est en arrière-plan (le navigateur ralentit le
    // timer mais ne le coupe pas) → le son retentit même sur un autre site.
    const fetchCount = async () => {
      try {
        // Le total seul : la liste des conversations n'est lue que par le Messenger (PERF-02).
        const res = await fetch("/api/messaging/sync?portee=badge", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        const total = data.totalUnread as number;
        setCount(total);
        window.dispatchEvent(new CustomEvent("amd:messaging-unread", { detail: { total } }));
      } catch {
        /* réseau : prochain tick */
      }
    };
    fetchCount();
    const t = setInterval(fetchCount, 12000);
    // Re-synchronise immédiatement au retour sur l'onglet.
    const onVis = () => { if (document.visibilityState === "visible") fetchCount(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [onMessagesPage]);

  return (
    <Link href="/messages" className="relative rounded-lg p-2 text-muted-foreground hover:bg-secondary" aria-label="Messagerie">
      <MessagesSquare className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold text-primary-foreground">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
