"use client";

import * as React from "react";
import { Megaphone, ArrowRight, Loader2 } from "lucide-react";
import { markNotificationRead } from "@/lib/actions/notification-actions";
import { useScrollLock } from "@/lib/use-scroll-lock";
import type { Popup } from "./notification-popup";

/**
 * LA FENÊTRE D'UNE ANNONCE — chargée par `notification-popup.tsx` quand une annonce arrive : le
 * sondage vit dans la coque, le dessin et l'accusé de réception ne servent qu'à ce moment-là.
 */
export function FenetreAnnonce({
  queue,
  dismissed,
  retirer,
}: {
  queue: Popup[];
  dismissed: React.RefObject<Set<string>>;
  retirer: (id: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const current = queue[0];

  // Verrouille le défilement tant qu'une pop-up est affichée — sur le VRAI conteneur défilant.
  useScrollLock(true);

  async function acknowledge(nav?: string | null) {
    if (busy) return;
    const id = current.id;
    setBusy(true);
    dismissed.current.add(id);
    try { await markNotificationRead(id); } catch { /* best-effort */ }
    setBusy(false);
    retirer(id);
    if (nav) { try { window.location.href = nav; } catch { /* ignore */ } }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="popup-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border bg-primary/5 px-5 py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Megaphone className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-primary">Annonce</p>
            <h2 id="popup-title" className="mt-0.5 break-words text-lg font-bold leading-snug">{current.title}</h2>
          </div>
        </div>

        {current.body && (
          <div className="max-h-[50vh] overflow-y-auto px-5 py-4">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{current.body}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {queue.length > 1 && (
            <span className="mr-auto text-xs text-muted-foreground">+{queue.length - 1} autre{queue.length - 1 > 1 ? "s" : ""}</span>
          )}
          {current.link && (
            <button
              type="button"
              onClick={() => acknowledge(current.link)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60"
            >
              Ouvrir <ArrowRight className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => acknowledge(null)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} J'ai compris
          </button>
        </div>
      </div>
    </div>
  );
}
