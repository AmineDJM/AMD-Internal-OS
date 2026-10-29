import Link from "next/link";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CONGRESS_REQUEST_STATUS, NATIONAL_EVENT_TYPE } from "@/lib/labels";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CongressListRow } from "@/modules/ad-pro/api";

export function CongressTable({ rows, basePath, showType }: { rows: CongressListRow[]; basePath: string; showType?: boolean }) {
  if (rows.length === 0) {
    return <EmptyState icon="CalendarDays" title="Aucune demande" description="Les demandes de prise en charge apparaîtront ici." />;
  }
  return (
    <div className="surface overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Événement</TableHead>
            {showType && <TableHead>Type</TableHead>}
            <TableHead>Lieu</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Demandeur</TableHead>
            <TableHead className="text-right">Budget estimé</TableHead>
            <TableHead className="text-right">Budget chef produit</TableHead>
            <TableHead>Statut</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell data-sans-etiquette className="font-medium">
                <div className="min-w-0 w-full">
                  <Link href={`${basePath}/${r.id}`} className="break-words hover:underline">{r.name}</Link>
                  {(r.specialty || r.doctorCount > 0) && (
                    <p className="text-xs text-muted-foreground">{[r.specialty, r.doctorCount > 0 ? `${r.doctorCount} médecin·s` : ""].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
              </TableCell>
              {showType && <TableCell className="text-muted-foreground">{r.eventType ? NATIONAL_EVENT_TYPE[r.eventType] ?? r.eventType : "—"}</TableCell>}
              <TableCell className="text-muted-foreground">{r.location || "—"}</TableCell>
              <TableCell className="text-muted-foreground">{r.date ? formatDate(r.date) : "—"}</TableCell>
              <TableCell className="text-muted-foreground">{r.requester || "—"}</TableCell>
              <TableCell className="text-right">{r.estimatedBudget !== null ? formatCurrency(r.estimatedBudget) : "—"}</TableCell>
              <TableCell className="text-right">{r.productManagerBudget !== null ? formatCurrency(r.productManagerBudget) : "—"}</TableCell>
              <TableCell><StatusBadge map={CONGRESS_REQUEST_STATUS} value={r.requestStatus} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
