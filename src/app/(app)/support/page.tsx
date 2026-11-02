import Link from "next/link";
import { ArrowRight, LifeBuoy, MessageSquare } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getSupportRequests } from "@/lib/queries/support";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { createSupportRequest } from "@/lib/actions/support-actions";
import { SUPPORT_CATEGORY, SUPPORT_STATUS, PRIORITY, ROLE_LABELS } from "@/lib/labels";

export const dynamic = "force-dynamic";

// Fonctions naturellement destinataires d'une demande de support (en tête de liste).
const SUPPORT_TARGET_ROLES = ["MEDICAL_PROMOTION_MANAGER", "PRODUCT_MANAGER", "MEDICAL_INFO_PHARMACIST", "HEAD_OF_REGULATORY"];

export default async function SupportPage() {
  const user = await requireModule("SUPPORT");

  const [requests, users] = await Promise.all([
    getSupportRequests(user),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
  ]);

  const orderedRoles = [
    ...SUPPORT_TARGET_ROLES,
    ...Object.keys(ROLE_LABELS).filter((r) => !SUPPORT_TARGET_ROLES.includes(r) && r !== "SUPER_ADMIN"),
  ];
  const roleOptions = [{ value: "", label: "— (ou choisir une personne) —" }, ...orderedRoles.map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r }))];
  const userOptions = [{ value: "", label: "— (ou choisir une fonction) —" }, ...users.map((u) => ({ value: u.id, label: `${u.name} — ${ROLE_LABELS[u.role] ?? u.role}` }))];

  return (
    <div className="space-y-5">
      <PageHeader title="Demandes de support" description="Adressez vos questions et demandes de supports, brochures ou documents au directeur médical, à la Direction Marketing ou à une autre fonction.">
        <CreateRecordButton
          label="Nouvelle demande"
          title="Demander un support"
          description="Posez votre question ou demandez un support / une brochure / un document. Le destinataire répond et peut joindre les pièces sur l'écran suivant."
          action={createSupportRequest}
          redirectBase="/support"
          fields={[
            { type: "text", name: "subject", label: "Objet", required: true },
            { type: "select", name: "category", label: "Type", options: optionsFromMap(SUPPORT_CATEGORY), defaultValue: "QUESTION" },
            { type: "textarea", name: "body", label: "Votre demande", required: true },
            { type: "text", name: "product", label: "Produit concerné (optionnel)" },
            { type: "select", name: "priority", label: "Priorité", options: optionsFromMap(PRIORITY), defaultValue: "MEDIUM" },
            { type: "select", name: "targetRole", label: "Destinataire — fonction", options: roleOptions },
            { type: "select", name: "targetUserId", label: "Destinataire — personne", options: userOptions },
          ]}
        />
      </PageHeader>

      {requests.length === 0 ? (
        <EmptyState icon="LifeBuoy" title="Aucune demande de support" description="Vos demandes et celles qui vous sont adressées apparaîtront ici." />
      ) : (
        <Card>
          <div className="divide-y divide-border">
            {requests.map((r) => (
              <Link key={r.id} href={`/support/${r.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-secondary/50 sm:flex-nowrap">
                <LifeBuoy className="h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.reference}</span>
                    <span className="truncate font-medium">{r.subject}</span>
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>de {r.requester?.name ?? "—"}</span>
                    <span>→ {r.targetUser?.name ?? (r.targetRole ? (ROLE_LABELS[r.targetRole] ?? r.targetRole) : "—")}</span>
                    <span>· {formatDate(r.createdAt.toISOString())}</span>
                    {r._count.messages > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {r._count.messages}</span>}
                  </p>
                </div>
                {/* Au téléphone, les pastilles passent sous le sujet au lieu de l'écraser. */}
                <span className="flex shrink-0 flex-wrap items-center gap-2 max-sm:order-last max-sm:basis-full max-sm:pl-9">
                  <StatusBadge map={SUPPORT_CATEGORY} value={r.category} dot={false} />
                  <StatusBadge map={SUPPORT_STATUS} value={r.status} />
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
