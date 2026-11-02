import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { getDeletedRequests } from "@/lib/queries/admin-requests";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADMIN_REQUEST_TYPE, PRIORITY } from "@/lib/labels";
import { formatDateTime } from "@/lib/utils";
import { RestoreButton } from "./restore-button";
import { BackLink } from "@/components/shared/back-link";

export default async function CorbeillePage() {
  const user = await requireModule("ADMIN_REQUESTS");
  const isManager = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");
  if (!isManager) notFound();

  const deleted = await getDeletedRequests(user);

  return (
    <div className="space-y-5">
      <BackLink href="/demandes">
        <ArrowLeft className="h-4 w-4" /> Retour aux demandes
      </BackLink>
      <PageHeader title="Corbeille des demandes" description="Demandes supprimées — suppression tracée (qui, quand, pourquoi). Vous pouvez restaurer une demande." />

      {deleted.length === 0 ? (
        <EmptyState icon="Trash2" title="Corbeille vide" description="Aucune demande supprimée." />
      ) : (
        <div className="surface overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead>Titre</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Supprimée par</TableHead>
                <TableHead>Le</TableHead>
                <TableHead>Motif</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deleted.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell className="font-medium">{r.title} <StatusBadge map={PRIORITY} value={r.priority} dot={false} /></TableCell>
                  <TableCell>{ADMIN_REQUEST_TYPE[r.type] ?? r.type}</TableCell>
                  <TableCell className="text-muted-foreground">{r.deletedByName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{r.deletedAt ? formatDateTime(r.deletedAt) : "—"}</TableCell>
                  <TableCell className="max-w-[16rem] truncate text-muted-foreground" title={r.deletionReason ?? ""}>{r.deletionReason ?? "—"}</TableCell>
                  <TableCell className="text-right"><RestoreButton id={r.id} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
