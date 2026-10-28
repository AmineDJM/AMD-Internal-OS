"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { fieldIsRecordable, cleanLabel, type EventKind } from "@/lib/replay/capture";
import { sansBloquer } from "@/lib/journal";

/**
 * L'ENREGISTREMENT DES ACTIONS — pour que le support puisse rembobiner.
 *
 * Ce N'EST PAS une vidéo. Un navigateur ne peut pas filmer l'écran sans autorisation explicite ni
 * indicateur visible : c'est une garantie du navigateur lui-même, pas un réglage qu'on désactive.
 * On enregistre la SUITE DES ACTIONS — pages, clics, saisies, envois, erreurs — ce que font
 * LogRocket ou FullStory, et ce qui suffit à reproduire un bug.
 *
 * ⚠️ AUCUNE VALEUR N'EST LUE. On ne touche jamais à `.value` : ni ici, ni dans l'envoi, ni côté
 * serveur. On capture le LIBELLÉ de l'élément (« Enregistrer », « Objet »), et les champs
 * sensibles — mot de passe, secret, RIB — sont écartés ENTIÈREMENT, avant même leur libellé.
 *
 * L'envoi part par `sendBeacon` : il survit à la fermeture de l'onglet et ne retarde jamais une
 * page. Un échec est silencieux — un confort d'exploitation ne doit rien casser.
 */

/** Toutes les 10 s, ou dès 30 événements : assez pour ne rien perdre, assez rare pour être discret. */
const FLUSH_MS = 10_000;
const FLUSH_AT = 30;

interface Pending {
  kind: EventKind;
  at: number;
  path: string;
  label: string | null;
  detail: string | null;
}

/** Le libellé d'un élément : son texte, son `aria-label`, son `title`, ou le nom du champ. */
function labelOf(el: Element | null): string | null {
  if (!el) return null;
  const target = el.closest("button, a, [role='button'], input, select, textarea, label") ?? el;
  const aria = target.getAttribute?.("aria-label") ?? target.getAttribute?.("title");
  if (aria) return cleanLabel(aria);
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    const id = target.getAttribute("id");
    const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null;
    return cleanLabel(lab ?? target.getAttribute("name") ?? target.getAttribute("placeholder"));
  }
  return cleanLabel(target.textContent);
}

export function SessionRecorder() {
  const pathname = usePathname();
  const queue = React.useRef<Pending[]>([]);
  const started = React.useRef<number>(Date.now());
  const sessionId = React.useRef<string>("");

  // L'identifiant de session vit dans l'onglet : un rechargement garde le fil, une nouvelle
  // fenêtre en ouvre un autre — c'est bien le déroulé d'UNE session qu'on veut rejouer.
  if (!sessionId.current && typeof window !== "undefined") {
    try {
      const existing = window.sessionStorage.getItem("amd-replay-sid");
      if (existing) {
        sessionId.current = existing;
        const t = window.sessionStorage.getItem("amd-replay-t0");
        if (t) started.current = Number(t) || Date.now();
      } else {
        sessionId.current = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        window.sessionStorage.setItem("amd-replay-sid", sessionId.current);
        window.sessionStorage.setItem("amd-replay-t0", String(started.current));
      }
    } catch {
      // Stockage refusé (navigation privée stricte) : on enregistre quand même, sur une session
      // qui ne survivra pas au rechargement. Mieux qu'aucune trace.
      sessionId.current = `s${Date.now().toString(36)}`;
    }
  }

  const flush = React.useCallback((keepalive = false) => {
    const events = queue.current;
    if (events.length === 0 || !sessionId.current) return;
    queue.current = [];
    const payload = JSON.stringify({ sessionId: sessionId.current, events });
    try {
      if (keepalive && navigator.sendBeacon) {
        navigator.sendBeacon("/api/replay", new Blob([payload], { type: "application/json" }));
      } else {
        void fetch("/api/replay", { method: "POST", body: payload, keepalive: true }).catch(sansBloquer("session-recorder.SessionRecorder.fetch"));
      }
    } catch { /* un rejeu perdu ne vaut pas une erreur à l'écran */ }
  }, []);

  const push = React.useCallback((kind: EventKind, label: string | null, detail: string | null = null) => {
    queue.current.push({
      kind, at: Date.now() - started.current,
      path: window.location.pathname.slice(0, 200), label, detail,
    });
    if (queue.current.length >= FLUSH_AT) flush();
  }, [flush]);

  // Changement de page.
  React.useEffect(() => {
    push("PAGE", null);
  }, [pathname, push]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest) return;
      const actionable = el.closest("button, a, [role='button'], input[type='submit']");
      if (!actionable) return;
      if (!fieldIsRecordable({ label: labelOf(actionable), type: actionable.getAttribute("type") })) return;
      push("CLICK", labelOf(actionable));
    };

    // On écoute `change`, pas `input` : une frappe par touche n'apprend rien, et « ce champ a été
    // rempli » suffit à reproduire. La VALEUR n'est jamais lue.
    const onChange = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const type = el.getAttribute("type");
      const label = labelOf(el);
      if (!fieldIsRecordable({ label, name: el.getAttribute("name"), type })) return;
      push("INPUT", label);
    };

    const onSubmit = (e: Event) => {
      const form = e.target as HTMLElement | null;
      push("SUBMIT", cleanLabel(form?.getAttribute("aria-label") ?? form?.getAttribute("name")));
    };

    // LES ERREURS — c'est pour elles que le rejeu existe.
    const onError = (e: ErrorEvent) => push("ERROR", null, e.message);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: unknown } | undefined;
      push("ERROR", null, typeof r?.message === "string" ? r.message : "Promesse rejetée");
    };

    const onHide = () => { if (document.visibilityState === "hidden") flush(true); };

    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onHide);
    const timer = window.setInterval(() => flush(), FLUSH_MS);

    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onHide);
      window.clearInterval(timer);
      flush(true);
    };
  }, [push, flush]);

  return null;
}
