import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getWorkflowDefinitions } from "@/lib/queries/workflow";
import { CATEGORY_LABELS, type WorkflowCategory } from "@/lib/workflow/types";
import { PageHeader } from "@/components/shared/page-header";
import { WorkflowBuilder } from "./workflow-builder";
import { WorkflowVersionHistory, type WorkflowVersionRow } from "./version-history";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

/**
 * Éditeur « no-code » des circuits de validation Ad & Pro — réservé au Super Admin.
 * Chaque catégorie (Sponsoring, Congrès intl/national, Événements) a une définition
 * entièrement modifiable : ajouter/supprimer/réordonner des étapes, choisir les rôles
 * impliqués et leurs pouvoirs, régler les détails (montant/catégorie obligatoires,
 * désignation, émission d'ordre de dépense, confidentialité…).
 */
export default async function AdminWorkflowsPage() {
  const user = await requireModule("ADMIN");
  if (user.role !== "SUPER_ADMIN") notFound();
  const definitions = await getWorkflowDefinitions();

  // L'HISTORIQUE : les 24 derniers instantanés, tous circuits confondus — chacun restaurable.
  const versions = await prisma.workflowDefinitionVersion.findMany({
    orderBy: { createdAt: "desc" },
    take: 24,
    select: { category: true, version: true, name: true, snapshot: true, savedById: true, createdAt: true },
  });
  const savers = versions.some((v) => v.savedById)
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(versions.map((v) => v.savedById).filter((x): x is string => Boolean(x)))] } },
        select: { id: true, name: true },
      })
    : [];
  const saverName = new Map(savers.map((s) => [s.id, s.name]));
  const versionRows: WorkflowVersionRow[] = versions.map((v) => {
    const snap = v.snapshot as { steps?: unknown[] } | null;
    return {
      category: v.category,
      categoryLabel: CATEGORY_LABELS[v.category as WorkflowCategory] ?? v.category,
      version: v.version,
      name: v.name,
      stepCount: Array.isArray(snap?.steps) ? snap.steps.length : 0,
      savedBy: v.savedById ? saverName.get(v.savedById) ?? null : null,
      savedAt: v.createdAt.toISOString().slice(0, 16).replace("T", " "),
    };
  });

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Circuits de validation (Ad & Pro)"
        description="Configurez chaque circuit comme une app no-code : étapes, rôles impliqués, pouvoirs, détails. Les demandes en cours suivent les étapes portant les mêmes identifiants."
      />
      <WorkflowBuilder definitions={definitions} />
      <WorkflowVersionHistory rows={versionRows} />
    </div>
  );
}
