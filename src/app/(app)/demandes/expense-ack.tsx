"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Receipt, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ackExpenseOriginals } from "@/modules/rh/actions-documents";
import { formatMonth, formatDate } from "@/lib/utils";

export interface ExpenseAckItem {
  id: string;
  employeeName: string;
  expenseMonth: string | null;
  createdAt: string;
}

/**
 * Bureau du secrétariat : notes de frais dont les ORIGINAUX n'ont pas encore été
 * réceptionnés. Un clic vaut accusé de réception (tracé, notifié à l'employé et aux RH).
 */
export function ExpenseAckList({ items }: { items: ExpenseAckItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  if (items.length === 0) return null;

  async function ack(item: ExpenseAckItem) {
    if (!window.confirm(`Accuser réception des originaux de la note de frais de ${item.employeeName} (${formatMonth(item.expenseMonth)}) ?`)) return;
    setBusyId(item.id); setErr(null);
    const fd = new FormData(); fd.set("id", item.id);
    const r = await ackExpenseOriginals(fd);
    setBusyId(null);
    if (!r.ok) setErr(r.error ?? "Échec."); else router.refresh();
  }

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Notes de frais — originaux à réceptionner ({items.length})
      </h2>
      <div className="surface divide-y divide-border">
        {items.map((it) => (
          <div key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <Receipt className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{it.employeeName} — {formatMonth(it.expenseMonth)}</p>
              <p className="text-xs text-muted-foreground">Demande du {formatDate(it.createdAt)} · en attente du dépôt des originaux</p>
            </div>
            <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => ack(it)}>
              {busyId === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Accuser réception
            </Button>
          </div>
        ))}
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </section>
  );
}
