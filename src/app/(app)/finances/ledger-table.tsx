"use client";

import * as React from "react";
import { Pencil, Trash2, Loader2 } from "lucide-react";
import { DataTable, type Column } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useFormAction, useKeyedAction } from "@/components/shared/use-action";
import { FINANCE_CATEGORY, FINANCE_METHOD, FINANCE_STATUS, FINANCE_DIRECTION } from "@/lib/labels";
import { formatCurrency, formatDate } from "@/lib/utils";
import { updateTransaction, deleteTransaction } from "@/modules/finances/actions-tresorerie";
import type { LedgerRow } from "@/modules/finances/api";

export function LedgerTable({ rows, canUpdate = false, canDelete = false }: { rows: LedgerRow[]; canUpdate?: boolean; canDelete?: boolean }) {
  const [edit, setEdit] = React.useState<LedgerRow | null>(null);
  // L'icône « supprimer » n'a pas de place pour parler : un refus part en avis flottant.
  const { busy: busyId, run } = useKeyedAction({ signalerErreurs: true });

  const onDelete = (r: LedgerRow) => {
    const fd = new FormData(); fd.set("id", r.id);
    void run(r.id, () => deleteTransaction(fd), {
      confirmer: { titre: `Supprimer définitivement l'écriture « ${r.label} » (${r.reference}) ?`, message: "La trésorerie sera recalculée.", confirmer: "Supprimer" },
      succes: "Écriture supprimée.",
    });
  };

  const columns: Column<LedgerRow>[] = [
    { key: "date", header: "Date", sortable: true, accessor: (r) => r.date, render: (r) => formatDate(r.date) },
    { key: "reference", header: "Réf.", sortable: true, accessor: (r) => r.reference, render: (r) => <span className="font-mono text-xs">{r.reference}</span> },
    { key: "label", header: "Libellé", sortable: true, accessor: (r) => r.label, render: (r) => <span className="font-medium">{r.label}</span> },
    { key: "category", header: "Catégorie", sortable: true, accessor: (r) => FINANCE_CATEGORY[r.category] ?? r.category, render: (r) => FINANCE_CATEGORY[r.category] ?? r.category },
    { key: "direction", header: "Sens", sortable: true, accessor: (r) => r.direction, render: (r) => <StatusBadge map={FINANCE_DIRECTION} value={r.direction} dot={false} /> },
    { key: "account", header: "Compte", sortable: true, accessor: (r) => r.account },
    { key: "counterparty", header: "Tiers", accessor: (r) => r.counterparty },
    { key: "method", header: "Moyen", accessor: (r) => FINANCE_METHOD[r.method] ?? r.method },
    { key: "amount", header: "Montant", align: "right", sortable: true, accessor: (r) => r.signedAmount,
      render: (r) => (
        <span className={r.direction === "IN" ? "font-semibold text-success" : "font-semibold text-destructive"}>
          {r.direction === "IN" ? "+" : "−"} {formatCurrency(r.amount)}
        </span>
      ) },
    { key: "status", header: "Statut", sortable: true, accessor: (r) => FINANCE_STATUS[r.status]?.label ?? r.status,
      render: (r) => <StatusBadge map={FINANCE_STATUS} value={r.status} /> },
  ];

  // Colonne d'actions (modifier / supprimer) — visible seulement selon les droits.
  if (canUpdate || canDelete) {
    columns.push({
      key: "actions", header: "", align: "right", accessor: () => "",
      render: (r) => (
        <div className="flex items-center justify-end gap-0.5">
          {canUpdate && (
            <button title="Modifier l'écriture" onClick={() => setEdit(r)} className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5">
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button title="Supprimer l'écriture" onClick={() => onDelete(r)} disabled={busyId === r.id} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:p-1.5">
              {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          )}
        </div>
      ),
    });
  }

  return (
    <>
      <DataTable rows={rows} columns={columns} filename="livre-comptable" pageSize={20}
        searchPlaceholder="Rechercher libellé, tiers, référence…"
        emptyTitle="Aucune écriture" emptyDescription="Ajoutez une recette ou une dépense." />
      {edit && <EditTransactionSheet row={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function EditTransactionSheet({ row, onClose }: { row: LedgerRow; onClose: () => void }) {
  const { action: submit, busy, err } = useFormAction(updateTransaction, { prepare: (fd) => fd.set("id", row.id), onOk: onClose });
  return (
    <Sheet open onClose={onClose} title={`Modifier l'écriture ${row.reference}`} description="Livre comptable — la trésorerie est recalculée automatiquement." width="md">
      <form action={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Date</Label><Input type="date" name="date" defaultValue={row.date.slice(0, 10)} /></div>
        <div className="space-y-1.5"><Label>Sens</Label>
          <Select name="direction" defaultValue={row.direction}>
            {Object.entries(FINANCE_DIRECTION).map(([v, o]) => <option key={v} value={v}>{o.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Libellé</Label><Input name="label" defaultValue={row.label} required /></div>
        <div className="space-y-1.5"><Label>Catégorie</Label>
          <Select name="category" defaultValue={row.category}>
            {Object.entries(FINANCE_CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5"><Label>Montant (DZD)</Label><Input type="number" inputMode="decimal" step="any" name="amount" defaultValue={row.amount} required /></div>
        <div className="space-y-1.5"><Label>Moyen de paiement</Label>
          <Select name="method" defaultValue={row.method}>
            {Object.entries(FINANCE_METHOD).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5"><Label>Compte</Label><Input name="account" defaultValue={row.account} /></div>
        <div className="space-y-1.5"><Label>Tiers</Label><Input name="counterparty" defaultValue={row.counterparty} /></div>
        <div className="space-y-1.5"><Label>Réf. facture</Label><Input name="invoiceRef" defaultValue={row.invoiceRef} /></div>
        <div className="space-y-1.5"><Label>Statut</Label>
          <Select name="status" defaultValue={row.status}>
            {Object.entries(FINANCE_STATUS).map(([v, o]) => <option key={v} value={v}>{typeof o === "string" ? o : o.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea name="notes" defaultValue={row.notes} rows={2} /></div>
        <Retour ton="erreur" className="sm:col-span-2">{err}</Retour>
        <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onClose}>Annuler</Button>
          <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
        </div>
      </form>
    </Sheet>
  );
}
