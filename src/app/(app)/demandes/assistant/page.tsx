import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getAssistantData } from "@/lib/queries/admin-requests";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, PRIORITY } from "@/lib/labels";
import { formatDate, daysUntil } from "@/lib/utils";
import { BackLink } from "@/components/shared/back-link";

export default async function AssistantPage() {
  const user = await requireModule("ADMIN_REQUESTS");
  const data = await getAssistantData(user);
  const s = data.stats;

  return (
    <div className="space-y-5">
      <BackLink href="/demandes">
        <ArrowLeft className="h-4 w-4" /> Toutes les demandes
      </BackLink>
      <PageHeader title="Bureau de Donna" description="Toutes les demandes à traiter, priorisées, sur un seul écran." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Nouvelles" value={s.nouvelles} icon="Sparkles" tone="info" />
        <KpiCard label="Urgentes" value={s.urgentes} icon="Flame" tone={s.urgentes > 0 ? "danger" : "default"} />
        <KpiCard label="En retard" value={s.enRetard} icon="AlarmClock" tone={s.enRetard > 0 ? "danger" : "default"} />
        <KpiCard label="Attente validation" value={s.attenteValidation} icon="ShieldQuestion" tone={s.attenteValidation > 0 ? "warning" : "default"} />
        <KpiCard label="Attente paiement" value={s.attentePaiement} icon="Banknote" tone={s.attentePaiement > 0 ? "warning" : "default"} />
        <KpiCard label="En cours" value={s.enCours} icon="Play" />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">À traiter ({data.open.length})</h2>
        {data.open.length === 0 ? (
          <EmptyState icon="CheckCheck" title="Rien à traiter" description="Toutes les demandes sont à jour." />
        ) : (
          <div className="surface overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Référence</TableHead><TableHead>Titre</TableHead><TableHead>Type</TableHead>
                  <TableHead>Priorité</TableHead><TableHead>Statut</TableHead><TableHead>Échéance</TableHead><TableHead>Demandeur</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.open.map((r) => {
                  const d = r.deadline ? daysUntil(r.deadline) : null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                      <TableCell className="font-medium"><Link href={`/demandes/${r.id}`} className="hover:underline">{r.title}</Link></TableCell>
                      <TableCell>{ADMIN_REQUEST_TYPE[r.type] ?? r.type}</TableCell>
                      <TableCell><StatusBadge map={PRIORITY} value={r.priority} dot={false} /></TableCell>
                      <TableCell><StatusBadge map={ADMIN_REQUEST_STATUS} value={r.status} /></TableCell>
                      <TableCell className={d !== null && d < 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {r.deadline ? formatDate(r.deadline) : "—"}{d !== null && d < 0 ? " · en retard" : ""}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.requester?.name ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
