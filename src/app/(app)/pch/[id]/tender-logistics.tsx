"use client";

import * as React from "react";
import { useKeyedAction } from "@/components/shared/use-action";
import { Truck, Loader2, CheckCircle2 } from "lucide-react";
import { setOrderArrival } from "@/lib/actions/pch-tender-line-actions";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PchOrderDTO } from "@/lib/queries/pch";

const d10 = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** Suivi logistique : dates d'arrivée prévue / réelle des bons de commande (client = PCH). */
export function TenderLogistics({ tenderId, orders, canEdit }: { tenderId: string; orders: PchOrderDTO[]; canEdit: boolean }) {
  // Une date saisie dans une ligne n'a pas de place pour parler : un refus part en avis flottant.
  const { busy, run } = useKeyedAction({ signalerErreurs: true });

  async function save(orderId: string, expectedArrival: string, arrivedDate: string) {
    if (busy) return;
    const fd = new FormData(); fd.set("id", orderId); fd.set("tenderId", tenderId);
    fd.set("expectedArrival", expectedArrival); fd.set("arrivedDate", arrivedDate);
    await run(orderId, async () => {
      const r = await setOrderArrival(fd);
      return r.ok ? r : { ...r, error: r.error ?? "La date d'arrivée n'a pas été enregistrée." };
    });
  }

  if (orders.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-base font-semibold"><Truck className="h-4 w-4 text-primary" /> Logistique — acheminement (client : PCH)</h3>
      <div className="rounded-lg border border-border">
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow><TableHead>Bon de commande</TableHead><TableHead>Arrivée prévue</TableHead><TableHead>Arrivée réelle</TableHead><TableHead className="text-center">Reçu</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => <LogisticsRow key={o.id} order={o} canEdit={canEdit} busy={busy === o.id} onSave={save} />)}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function LogisticsRow({ order, canEdit, busy, onSave }: { order: PchOrderDTO; canEdit: boolean; busy: boolean; onSave: (id: string, e: string, a: string) => void }) {
  const [expected, setExpected] = React.useState(d10(order.expectedArrival));
  const [arrived, setArrived] = React.useState(d10(order.arrivedDate));
  const cls = "h-10 w-full rounded-md border border-input bg-background px-2 text-base focus:border-primary focus:outline-none disabled:opacity-60 sm:h-8 sm:w-auto sm:text-sm";
  return (
    <TableRow>
      <TableCell data-sans-etiquette className="font-medium [overflow-wrap:anywhere]">{order.reference || "—"} <span className="text-xs font-normal text-muted-foreground">· {order.products || "—"}</span></TableCell>
      <TableCell>{canEdit ? <input type="date" className={cls} value={expected} disabled={busy} onChange={(e) => setExpected(e.target.value)} onBlur={() => onSave(order.id, expected, arrived)} /> : (expected || "—")}</TableCell>
      <TableCell>{canEdit ? <input type="date" className={cls} value={arrived} disabled={busy} onChange={(e) => setArrived(e.target.value)} onBlur={() => onSave(order.id, expected, arrived)} /> : (arrived || "—")}</TableCell>
      <TableCell className="sm:text-center">{busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground sm:mx-auto" /> : arrived ? <CheckCircle2 className="h-4 w-4 text-success sm:mx-auto" /> : <span className="text-xs text-muted-foreground">en attente</span>}</TableCell>
    </TableRow>
  );
}
