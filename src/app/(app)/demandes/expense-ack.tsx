"use client";

import { useKeyedAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";
import { Loader2, Receipt, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ackExpenseOriginals } from "@/lib/actions/hr-document-actions";
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
  const { busy: busyId, error: err, run } = useKeyedAction();

  if (items.length === 0) return null;

  async function ack(item: ExpenseAckItem) {
    const fd = new FormData(); fd.set("id", item.id);
    await run(item.id, () => ackExpenseOriginals(fd), {
      confirmer: `Accuser réception des originaux de la note de frais de ${item.employeeName} (${formatMonth(item.expenseMonth)}) ?`,
    });
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
            <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => void ack(it)}>
              {busyId === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Accuser réception
            </Button>
          </div>
        ))}
      </div>
      <Retour ton="erreur">{err}</Retour>
    </section>
  );
}
