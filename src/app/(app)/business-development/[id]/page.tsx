import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { getBdProject } from "@/lib/queries/bd";
import { addBdProjectComment } from "@/lib/actions/bd-project-actions";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import { PageHeader } from "@/components/shared/page-header";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CommentThread } from "@/components/shared/comment-thread";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { formatCompact } from "@/lib/utils";
import { BdStrategicTable } from "../bd-strategic-table";
import { ProjectEditor, ProjectStatusBadge } from "../project-editor";
import { BackLink } from "@/components/shared/back-link";

const BD_DOC_CATEGORIES = [
  "SUPPLIER_OFFER", "QUOTE", "PROFORMA", "ANALYSIS_CERTIFICATE", "PRESENTATION", "SUPPORTING_DOC", "OTHER",
];

export default async function BdProjectDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("BUSINESS_DEVELOPMENT");
  if (!(await canAccessEntity(user, "BD_PROJECT", params.id, "VIEW"))) notFound();

  const project = await getBdProject(user, params.id);
  if (!project) notFound();

  const canUpdate = userCan(user, "BUSINESS_DEVELOPMENT", "UPDATE");
  const canUpload = userCan(user, "BUSINESS_DEVELOPMENT", "UPLOAD");
  const canDelete = userCan(user, "BUSINESS_DEVELOPMENT", "DELETE");

  const [documents, comments] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "BD_PROJECT", entityId: project.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.comment.findMany({
      where: { entityType: "BD_PROJECT", entityId: project.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  let rev3 = 0, inv3 = 0;
  for (const r of project.ranges) for (const p of r.products) {
    rev3 += (p.revenueY1 ?? 0) + (p.revenueY2 ?? 0) + (p.revenueY3 ?? 0);
    inv3 += (p.investmentY1 ?? 0) + (p.investmentY2 ?? 0) + (p.investmentY3 ?? 0);
  }

  return (
    <div className="space-y-5">
      <BackLink href="/business-development">
        <ArrowLeft className="h-4 w-4" /> Projets stratégiques
      </BackLink>

      <PageHeader title={project.name} description={project.description || "Projet stratégique — gammes et produits."}>
        <ProjectStatusBadge status={project.status} />
        {canUpdate && (
          <ProjectEditor id={project.id} name={project.name} status={project.status} description={project.description} comment={project.comment} />
        )}
        <SuperAdminDeleteButton kind="BD_PROJECT" id={project.id} name={project.name} enabled={user.role === "SUPER_ADMIN"} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Gammes" value={project.rangeCount} icon="Layers" />
        <KpiCard label="Produits (DCI)" value={project.productCount} icon="Pill" />
        <KpiCard label="Revenus estimés 3 ans" value={formatCompact(rev3)} icon="TrendingUp" tone="success" />
        <KpiCard label="Investissement 3 ans" value={formatCompact(inv3)} icon="Banknote" tone="warning" />
        <KpiCard label="Responsable" value={project.owner || "—"} icon="UserRound" />
      </div>

      {project.comment && (
        <Card>
          <CardHeader><CardTitle>Commentaire</CardTitle></CardHeader>
          <CardContent><p className="whitespace-pre-wrap text-sm text-foreground/90">{project.comment}</p></CardContent>
        </Card>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Gammes & produits</h2>
        <BdStrategicTable projects={[project]} canUpdate={canUpdate} canDelete={canDelete} />
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Commentaires</CardTitle></CardHeader>
          <CardContent>
            <CommentThread
              comments={comments.map((c) => ({ id: c.id, author: c.author?.name ?? "Utilisateur", authorId: c.authorId, body: c.body, createdAt: c.createdAt.toISOString(), editedAt: c.editedAt?.toISOString() ?? null }))}
              action={addBdProjectComment}
              hiddenFields={{ projectId: project.id }}
              currentUserId={user.id}
              canModerate={canUpdate}
              updateAction={updateComment}
              deleteAction={deleteComment}
              path={`/business-development/${project.id}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Documents</CardTitle>
            <Badge tone="neutral">{docItems.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {canUpload && <DocumentUpload entityType="BD_PROJECT" entityId={project.id} categories={BD_DOC_CATEGORIES} />}
            <DocumentList documents={docItems} canDelete={canDelete} canEdit={onlyofficeConfigured() && canUpload} path={`/business-development/${project.id}`} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
