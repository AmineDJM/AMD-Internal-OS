"use client";

import * as React from "react";
import { BellPlus, Check, Loader2 } from "lucide-react";
import { createReminder } from "@/lib/actions/reminder-actions";
import { cn } from "@/lib/utils";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * RAPPEL EN UN CLIC — pose un rappel personnel sur l'objet courant (dossier, demande, sujet…).
 * Présélections rapides (dans 1 h, ce soir, demain, …) calculées à l'heure LOCALE de l'utilisateur ;
 * un champ « date précise » couvre le reste. À l'échéance, une notification (cloche + push) arrive.
 */
function atHour(base: Date, hour: number, addDays = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export function ReminderButton({
  defaultTitle, link, entityType, entityId, label = "Me rappeler", className,
}: {
  defaultTitle?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  label?: string;
  className?: string;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [title, setTitle] = React.useState(defaultTitle ?? "");
  const [custom, setCustom] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const now = new Date();
  const presets: { label: string; at: Date }[] = [
    { label: "Dans 1 h", at: new Date(now.getTime() + 3600_000) },
    { label: "Ce soir (18 h)", at: atHour(now, 18) },
    { label: "Demain (9 h)", at: atHour(now, 9, 1) },
    { label: "Dans 3 jours", at: atHour(now, 9, 3) },
    { label: "Semaine prochaine", at: atHour(now, 9, 7) },
  ].filter((p) => p.at.getTime() > now.getTime() + 30_000);

  async function submit(at: Date) {
    const t = title.trim();
    if (!t) { setError("Indiquez l'objet du rappel."); return; }
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) { setError("Choisissez une date future."); return; }
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.set("title", t);
    fd.set("remindAt", at.toISOString());
    if (link) fd.set("link", link);
    if (entityType) fd.set("entityType", entityType);
    if (entityId) fd.set("entityId", entityId);
    try {
      const r = await createReminder(fd);
      if (r.ok) {
        setDone(true); setOpen(false); rafraichir();
        setTimeout(() => setDone(false), 2500);
      } else {
        setError(r.error ?? "Échec de la création du rappel.");
      }
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-accent sm:px-2.5 sm:py-1.5"
      >
        {done ? <Check className="h-3.5 w-3.5 text-success" /> : <BellPlus className="h-3.5 w-3.5" />}
        {done ? "Rappel posé" : label}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent" onClick={() => setOpen(false)} />
          {/* Au téléphone, un panneau ancré en bas de l'écran : un menu flottant de 18 rem sortait par la gauche
              dès que le bouton n'était pas collé au bord droit. */}
          <div className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-50 max-h-[90dvh] overflow-y-auto rounded-lg border border-border bg-popover p-3 shadow-lg sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:mt-1 sm:max-h-none sm:w-72 sm:overflow-visible">
            <p className="mb-1.5 text-xs font-semibold text-foreground">Me rappeler…</p>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Objet du rappel"
              className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={busy}
                  onClick={() => submit(p.at)}
                  className="rounded-full border border-border px-3 py-2 text-xs transition-colors sm:px-2.5 sm:py-1 sm:text-[0.6875rem] hover:bg-accent disabled:opacity-50"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <input
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-2 text-xs outline-none focus:ring-2 focus:ring-ring sm:py-1"
              />
              <button
                type="button"
                disabled={busy || !custom}
                onClick={() => submit(new Date(custom))}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50 sm:px-2 sm:py-1"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "OK"}
              </button>
            </div>
            {error && <p className="mt-1.5 text-[0.6875rem] text-destructive">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
