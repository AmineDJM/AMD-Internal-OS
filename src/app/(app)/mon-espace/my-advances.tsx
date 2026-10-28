"use client";

import * as React from "react";
import { Loader2, X } from "lucide-react";
import { cancelAdvance } from "@/modules/rh/actions";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADVANCE_STATUS } from "@/lib/labels";
import { formatCurrency, formatDate } from "@/lib/utils";

export interface AdvanceItem {
  id: string;
  amount: number;
  reason: string | null;
  status: string;
  createdAt: string;
}

function CancelButton({ id }: { id: string }) {
  const [saving, setSaving] = React.useState(false);
  return (
    <form action={async (fd) => { setSaving(true); await cancelAdvance(fd); setSaving(false); }} className="inline">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={saving}
        className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-xs sm:px-2 sm:py-1 font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Annuler
      </button>
    </form>
  );
}

export function MyAdvances({ advances }: { advances: AdvanceItem[] }) {
  if (advances.length === 0) {
    return <EmptyState icon="Banknote" title="Aucune demande d'avance" description="Vos demandes d'avance sur salaire apparaîtront ici." />;
  }
  return (
    <div className="surface overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Montant</TableHead>
            <TableHead>Motif</TableHead>
            <TableHead>Statut</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {advances.map((a) => (
            <TableRow key={a.id}>
              <TableCell>{formatDate(a.createdAt)}</TableCell>
              <TableCell className="text-right font-semibold">{formatCurrency(a.amount)}</TableCell>
              <TableCell className="break-words text-muted-foreground sm:max-w-[220px] sm:truncate">{a.reason || "—"}</TableCell>
              <TableCell><StatusBadge map={ADVANCE_STATUS} value={a.status} /></TableCell>
              <TableCell className="text-right">{a.status === "PENDING" ? <CancelButton id={a.id} /> : <span className="text-muted-foreground">—</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
