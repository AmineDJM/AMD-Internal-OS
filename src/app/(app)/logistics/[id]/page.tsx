import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency, formatDate, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { LOGISTICS_STATUS } from "@/lib/labels";
import { StatusUpdate } from "./status-update";
import { BackLink } from "@/components/shared/back-link";

const LOGISTICS_DOC_CATEGORIES = ["PROFORMA", "INVOICE", "PACKING_LIST", "BL_AWB", "ANALYSIS_CERTIFICATE", "ORIGIN_CERTIFICATE", "CUSTOMS_DOCS", "DELIVERY_NOTE", "RECEPTION_REPORT", "OTHER"];

export default async function LogisticsDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("LOGISTICS");
  const order = await prisma.logisticsOrder.findUnique({
    where: { id: params.id },
    include: { owner: { select: { name: true } } },
  });
  if (!order) notFound();

  const documents = await prisma.document.findMany({
    where: { entityType: "LOGISTICS", entityId: order.id },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  const canUpdate = userCan(user, "LOGISTICS", "UPDATE");
  const canUpload = userCan(user, "LOGISTICS", "UPLOAD");
  const canDelete = userCan(user, "LOGISTICS", "DELETE");

  const milestones = [
    { label: "Commande", planned: order.orderDate, real: order.orderDate },
    { label: "Départ", planned: order.estimatedDeparture, real: order.actualDeparture },
    { label: "Arrivée terminal", planned: order.estimatedArrival, real: order.actualArrival },
    { label: "Dédouanement", planned: null, real: order.customsDate },
    { label: "Livraison PCH", planned: null, real: order.pchDeliveryDate },
  ];

  return (
    <div className="space-y-5">
      <BackLink href="/logistics">
        <ArrowLeft className="h-4 w-4" /> Retour aux commandes
      </BackLink>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <span className="font-mono text-xs text-muted-foreground">{order.reference}</span>
          <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{order.product}</h1>
          <p className="text-muted-foreground">{order.supplier} · {order.country}</p>
        </div>
        <StatusBadge map={LOGISTICS_STATUS} value={order.status} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Timeline logistique</CardTitle></CardHeader>
            <CardContent>
              <ol className="relative space-y-4">
                {milestones.map((m, i) => {
                  const done = Boolean(m.real);
                  return (
                    <li key={i} className="relative flex items-start gap-3 pl-1">
                      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs",
                        done ? "bg-success text-success-foreground" : "bg-secondary text-muted-foreground")}>
                        {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{m.label}</p>
                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                          {m.planned && <span>Estimé : {formatDate(m.planned)}</span>}
                          <span className={done ? "text-success" : ""}>Réel : {m.real ? formatDate(m.real) : "—"}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Informations</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 sm:gap-x-6">
              <Info label="Transporteur" value={order.carrier} />
              <Info label="Incoterm" value={order.incoterm} />
              <Info label="N° facture" value={order.invoiceNumber} />
              <Info label="N° BL/AWB" value={order.blAwbNumber} />
              <Info label="Qté commandée" value={String(order.quantityOrdered)} />
              <Info label="Qté reçue" value={String(order.quantityReceived)} />
              <Info label="Valeur" value={order.orderValue ? formatCurrency(toNumber(order.orderValue), order.currency) : null} />
              <Info label="Devise" value={order.currency} />
              <Info label="Responsable" value={order.owner?.name} />
            </CardContent>
          </Card>

          {canUpdate && (
            <Card>
              <CardHeader><CardTitle>Mettre à jour le suivi</CardTitle></CardHeader>
              <CardContent>
                <StatusUpdate
                  id={order.id}
                  status={order.status}
                  actualDeparture={order.actualDeparture?.toISOString() ?? null}
                  actualArrival={order.actualArrival?.toISOString() ?? null}
                  customsDate={order.customsDate?.toISOString() ?? null}
                  pchDeliveryDate={order.pchDeliveryDate?.toISOString() ?? null}
                  quantityReceived={order.quantityReceived}
                />
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Documents</CardTitle>
            <Badge tone="neutral">{docItems.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {canUpload && <DocumentUpload entityType="LOGISTICS" entityId={order.id} categories={LOGISTICS_DOC_CATEGORIES} />}
            <DocumentList documents={docItems} canDelete={canDelete} canEdit={onlyofficeConfigured() && canUpload} path={`/logistics/${order.id}`} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums [overflow-wrap:anywhere]">{value || "—"}</p>
    </div>
  );
}
