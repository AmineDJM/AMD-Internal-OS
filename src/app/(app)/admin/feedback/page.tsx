import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { FeedbackAttachments } from "../../feedback/attachment-list";
import { FeedbackStatusSelect } from "./feedback-status";
import { BackLink } from "@/components/shared/back-link";

export default async function AdminFeedbackPage() {
  const user = await requireModule("ADMIN");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const feedbacks = await prisma.feedback.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { name: true, email: true, avatarColor: true } },
      // Les pièces avec le retour, dans la MÊME requête : c'est ce qui rend un bogue
      // reproductible plutôt que racontable.
      attachments: { select: { id: true, name: true, mime: true, size: true }, orderBy: { createdAt: "asc" } },
    },
    take: 300,
  });

  const stats = {
    toHandle: feedbacks.filter((f) => f.status === "NEW").length,
    inProgress: feedbacks.filter((f) => f.status === "IN_PROGRESS" || f.status === "SEEN").length,
    done: feedbacks.filter((f) => f.status === "DONE").length,
  };

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader title="Feedbacks" description="Les retours envoyés par les utilisateurs depuis leur compte." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiCard label="À traiter" value={stats.toHandle} icon="Inbox" tone={stats.toHandle > 0 ? "warning" : "default"} />
        <KpiCard label="En cours" value={stats.inProgress} icon="Loader" tone="info" />
        <KpiCard label="Traités" value={stats.done} icon="CheckCheck" tone="success" />
      </div>

      {feedbacks.length === 0 ? (
        <EmptyState icon="MessageSquare" title="Aucun feedback reçu" description="Les retours des utilisateurs apparaîtront ici." />
      ) : (
        <div className="space-y-2">
          {feedbacks.map((f) => (
            <Card key={f.id}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <Avatar name={f.user?.name ?? "?"} color={f.user?.avatarColor} size="sm" />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{f.user?.name ?? "Utilisateur"}</span>
                      <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{f.user?.email}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{f.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.module ? `${f.module} · ` : ""}{formatDateTime(f.createdAt)}
                    </p>
                    {/* Le Super Admin voit et peut retirer — c'est lui qui traite le retour. */}
                    <FeedbackAttachments items={f.attachments.map((a) => ({ ...a, canRemove: true }))} />
                  </div>
                </div>
                <div className="shrink-0">
                  <FeedbackStatusSelect id={f.id} status={f.status} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
