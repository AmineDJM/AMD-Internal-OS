"use client";

import * as React from "react";
import { useAction } from "@/components/shared/use-action";
import { Loader2, Play, Truck, CheckCircle2, AlertTriangle } from "lucide-react";
import { updateMission } from "@/lib/actions/admin-request-actions";
import { cn } from "@/lib/utils";

export function MissionActions({ id, status }: { id: string; status: string }) {
  // Les boutons de statut n'ont pas de place pour parler : un refus part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });

  function Btn({ s, label, icon, cls }: { s: string; label: string; icon: React.ReactNode; cls: string }) {
    return (
      <form action={async (fd) => { await run(() => updateMission(fd)); }} className="inline">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="status" value={s} />
        <button type="submit" disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50", cls)}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon} {label}
        </button>
      </form>
    );
  }

  if (status === "DONE" || status === "CANCELLED") return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {status === "NEW" && <Btn s="ACCEPTED" label="Accepter" icon={<Play className="h-3.5 w-3.5" />} cls="border-border text-foreground hover:bg-secondary" />}
      {status !== "EN_ROUTE" && <Btn s="EN_ROUTE" label="En route" icon={<Truck className="h-3.5 w-3.5" />} cls="border-blue-200 text-blue-600 hover:bg-blue-50" />}
      <Btn s="DONE" label="Terminé" icon={<CheckCircle2 className="h-3.5 w-3.5" />} cls="border-success/30 text-success hover:bg-success/10" />
      <Btn s="PROBLEM" label="Problème" icon={<AlertTriangle className="h-3.5 w-3.5" />} cls="border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive" />
    </div>
  );
}
