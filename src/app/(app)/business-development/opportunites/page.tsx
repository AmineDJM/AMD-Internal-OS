import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, scopeBusinessDevelopment } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { createBD } from "@/lib/actions/bd-actions";
import { BD_TYPE, BD_STATUS, PRIORITY } from "@/lib/labels";
import { BDTable, type BDRow } from "../bd-table";
import { BDPipeline } from "../bd-pipeline";
import { BackLink } from "@/components/shared/back-link";

export default async function BusinessDevelopmentOpportunitiesPage() {
  const user = await requireModule("BUSINESS_DEVELOPMENT");
  const canCreate = userCan(user, "BUSINESS_DEVELOPMENT", "CREATE");
  const canUpdate = userCan(user, "BUSINESS_DEVELOPMENT", "UPDATE");

  const items = await prisma.businessDevelopmentOpportunity.findMany({
    where: scopeBusinessDevelopment(user),
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
  });

  const rows: BDRow[] = items.map((o) => ({
    id: o.id, name: o.name, dci: o.dci ?? "", type: o.type, targetMarket: o.targetMarket ?? "",
    estimatedMarketSize: o.estimatedMarketSize ? toNumber(o.estimatedMarketSize) : null,
    potentialSupplier: o.potentialSupplier ?? "", supplierCountry: o.supplierCountry ?? "",
    status: o.status, priority: o.priority, score: o.score,
    nextAction: o.nextAction ?? "", nextActionDate: o.nextActionDate?.toISOString() ?? null,
  }));

  const inProgress = rows.filter((r) => !["VALIDATED", "ABANDONED"].includes(r.status)).length;
  const priority = rows.filter((r) => ["HIGH", "CRITICAL"].includes(r.priority)).length;
  const validated = rows.filter((r) => r.status === "VALIDATED").length;

  return (
    <div className="space-y-5">
      <BackLink href="/business-development">
        <ArrowLeft className="h-4 w-4" /> Projets stratégiques
      </BackLink>
      <PageHeader title="Opportunités (pipeline)" description="Pipeline historique des opportunités produits, scoring et suivi fournisseurs.">
        {canCreate && (
          <CreateRecordButton
            label="Nouvelle opportunité"
            title="Nouvelle opportunité"
            action={createBD}
            fields={[
              { type: "text", name: "name", label: "Opportunité", required: true, full: true },
              { type: "text", name: "dci", label: "DCI" },
              { type: "text", name: "therapeuticClass", label: "Classe thérapeutique" },
              { type: "select", name: "type", label: "Type", options: optionsFromMap(BD_TYPE), defaultValue: "GENERIC" },
              { type: "text", name: "targetMarket", label: "Marché cible" },
              { type: "number", name: "estimatedMarketSize", label: "Taille marché estimée (DZD)" },
              { type: "number", name: "estimatedPrice", label: "Prix estimé (DZD)" },
              { type: "text", name: "competitors", label: "Concurrents" },
              { type: "text", name: "potentialSupplier", label: "Fournisseur potentiel" },
              { type: "text", name: "supplierCountry", label: "Pays fournisseur" },
              { type: "text", name: "supplierContact", label: "Contact fournisseur" },
              { type: "select", name: "status", label: "Statut", options: optionsFromMap(BD_STATUS), defaultValue: "IDEA" },
              { type: "select", name: "priority", label: "Priorité", options: optionsFromMap(PRIORITY), defaultValue: "MEDIUM" },
              { type: "number", name: "score", label: "Score (0-100)" },
              { type: "text", name: "nextAction", label: "Prochaine action" },
              { type: "date", name: "nextActionDate", label: "Date prochaine action" },
            ]}
          />
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Opportunités" value={rows.length} icon="Lightbulb" />
        <KpiCard label="En cours" value={inProgress} icon="Activity" tone="info" />
        <KpiCard label="Prioritaires" value={priority} icon="Flame" tone="warning" />
        <KpiCard label="Validées" value={validated} icon="CheckCircle2" tone="success" />
      </div>

      <Card>
        <CardHeader><CardTitle>Pipeline</CardTitle></CardHeader>
        <CardContent>
          <BDPipeline rows={rows} canUpdate={canUpdate} />
        </CardContent>
      </Card>

      <BDTable rows={rows} />
    </div>
  );
}
