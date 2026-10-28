"use client";

import * as React from "react";
import { useModuleDiffere } from "@/components/ui/differe";

/** Diffusé à chaque sondage de `/api/notifications/poll` : `{ unread }`, écouté par le carillon. */
export const EVENEMENT_NON_LUES = "amd:notifications-unread";

export interface Popup {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
}

/**
 * Notifications **pop-up plein écran** (grande fenêtre centrée, façon alerte importante), diffusées
 * depuis l'Administration. On sonde les notifications pop-up non lues et on affiche la première de la
 * file au milieu de l'écran ; elle reste tant que la personne n'a pas cliqué sur « J'ai compris »
 * (accusé de réception = notification marquée lue). Les suivantes s'enchaînent une à une.
 * La fenêtre elle-même (`notification-popup-fenetre.tsx`) se charge après la page.
 */
export function NotificationPopup() {
  const [queue, setQueue] = React.useState<Popup[]>([]);
  const dismissed = React.useRef<Set<string>>(new Set());

  // Sondage : récupère les pop-up non lues et les met en file (sans doublon ni déjà-accusées).
  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/notifications/poll", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = await res.json();
        // LE SEUL SONDAGE de cette route dans la coque (PERF-04) : le carillon lit le compteur ici.
        window.dispatchEvent(new CustomEvent(EVENEMENT_NON_LUES, { detail: { unread: Number(data.unread ?? 0) } }));
        const incoming: Popup[] = Array.isArray(data.popups) ? data.popups : [];
        setQueue((cur) => {
          const seen = new Set(cur.map((p) => p.id));
          const add = incoming.filter((p) => !seen.has(p.id) && !dismissed.current.has(p.id));
          return add.length ? [...cur, ...add] : cur;
        });
      } catch { /* réseau : prochain tick */ }
    };
    tick();
    const t = setInterval(tick, 15000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const { module: fenetre } = useModuleDiffere(() => import("./notification-popup-fenetre"));
  const retirer = React.useCallback((id: string) => setQueue((cur) => cur.filter((p) => p.id !== id)), []);

  if (!queue.length || !fenetre) return null;
  return <fenetre.FenetreAnnonce key={queue[0].id} queue={queue} dismissed={dismissed} retirer={retirer} />;
}
