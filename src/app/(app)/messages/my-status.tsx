"use client";

import * as React from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { setMessagingStatus } from "@/lib/actions/messaging-actions";
import { CHAT_STATUS_LABEL, CHAT_STATUSES, type ChatStatus } from "@/lib/messaging-ui";
import { Input } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";

const DOT: Record<ChatStatus, string> = {
  AVAILABLE: "bg-emerald-500",
  BUSY: "bg-red-500",
  DND: "bg-rose-700",
  BRB: "bg-amber-400",
  AWAY: "bg-amber-400",
  OFFLINE: "bg-slate-400",
};

/**
 * Statut de messagerie façon Teams : l'utilisateur choisit son statut (Disponible, Occupé,
 * Ne pas déranger, De retour bientôt, Absent, Hors ligne) et un message perso court. « Auto »
 * repasse en présence automatique (selon l'activité).
 */
export function MyStatus({ name, status, message }: { name: string; status: string | null; message: string | null }) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState(message ?? "");
  const current = (status && (CHAT_STATUSES as string[]).includes(status)) ? (status as ChatStatus) : null;

  async function apply(next: ChatStatus | null, msg: string) {
    setBusy(true);
    const fd = new FormData();
    if (next) fd.set("status", next);
    fd.set("message", msg);
    try {
      await setMessagingStatus(fd);
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(false);
    }
    setOpen(false); rafraichir();
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-secondary/60">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-card ${current ? DOT[current] : "bg-emerald-500"}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{message || (current ? CHAT_STATUS_LABEL[current] : "Disponible (auto)")}</span>
        </span>
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 w-[min(16rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-2 shadow-xl">
            <ul className="space-y-0.5">
              {CHAT_STATUSES.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => apply(s, draft)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-secondary sm:py-1.5">
                    <span className={`h-2.5 w-2.5 rounded-full ${DOT[s]}`} />
                    <span className="flex-1">{CHAT_STATUS_LABEL[s]}</span>
                    {current === s && <Check className="h-4 w-4 text-primary" />}
                  </button>
                </li>
              ))}
              <li>
                <button type="button" onClick={() => apply(null, draft)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm text-muted-foreground hover:bg-secondary sm:py-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
                  <span className="flex-1">Automatique (présence)</span>
                  {!current && <Check className="h-4 w-4 text-primary" />}
                </button>
              </li>
            </ul>
            <div className="mt-2 space-y-1.5 border-t border-border pt-2">
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message de statut (optionnel)…" maxLength={120} className="h-10 text-base sm:h-8 lg:text-xs"
                onKeyDown={(e) => { if (e.key === "Enter") apply(current, draft); }} />
              <button type="button" onClick={() => apply(current, draft)} className="w-full rounded-md bg-primary px-2 py-2 text-xs sm:py-1 font-medium text-primary-foreground hover:opacity-90">
                Enregistrer le message
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
