"use client";

import { DataTable, type Column } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { BD_STATUS, BD_TYPE, PRIORITY } from "@/lib/labels";
import { formatDate } from "@/lib/utils";

export interface BDRow {
  id: string;
  name: string;
  dci: string;
  type: string;
  targetMarket: string;
  estimatedMarketSize: number | null;
  potentialSupplier: string;
  supplierCountry: string;
  status: string;
  priority: string;
  score: number | null;
  nextAction: string;
  nextActionDate: string | null;
}

export function BDTable({ rows }: { rows: BDRow[] }) {
  const columns: Column<BDRow>[] = [
    { key: "name", header: "Opportunité", sortable: true, accessor: (r) => r.name,
      render: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          {r.dci && <p className="text-xs text-muted-foreground">{r.dci}</p>}
        </div>
      ) },
    { key: "type", header: "Type", sortable: true, accessor: (r) => BD_TYPE[r.type] ?? r.type, render: (r) => BD_TYPE[r.type] ?? r.type },
    { key: "targetMarket", header: "Marché", accessor: (r) => r.targetMarket },
    { key: "potentialSupplier", header: "Fournisseur", accessor: (r) => r.potentialSupplier },
    { key: "supplierCountry", header: "Pays", accessor: (r) => r.supplierCountry },
    { key: "priority", header: "Priorité", sortable: true, accessor: (r) => r.priority, render: (r) => <StatusBadge map={PRIORITY} value={r.priority} /> },
    { key: "score", header: "Score", align: "right", sortable: true, accessor: (r) => r.score ?? 0, render: (r) => (r.score != null ? `${r.score}/100` : "—") },
    { key: "status", header: "Statut", sortable: true, accessor: (r) => BD_STATUS[r.status]?.label ?? r.status, render: (r) => <StatusBadge map={BD_STATUS} value={r.status} /> },
    { key: "nextActionDate", header: "Proch. action", sortable: true, accessor: (r) => r.nextActionDate ?? "",
      render: (r) => (r.nextActionDate ? formatDate(r.nextActionDate) : "—") },
  ];
  return <DataTable rows={rows} columns={columns} filename="business-development" searchPlaceholder="Rechercher opportunité, fournisseur…" emptyTitle="Aucune opportunité" />;
}
