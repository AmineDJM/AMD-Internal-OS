import { notFound } from "next/navigation";
import { ArrowLeft, MapPin, Paperclip, CalendarClock, User2 } from "lucide-react";
import { requireModule } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { PRIORITY, TASK_STATUS } from "@/lib/labels";
import { formatDate, formatDateTime } from "@/lib/utils";
import { canSee, canDoWork, canAttach, canRespond, canComment, isRequest, requestStage, declineSummary } from "@/lib/tasks/request-flow";
import { TaskWorkPanel } from "./work-panel";
import { TaskComments, type TaskCommentItem } from "./comments";

export const dynamic = "force-dynamic";

/**
 * LE DOSSIER D'UNE DEMANDE — on entre, on fait, on valide. Rien entre les deux.
 *
 * C'est l'écran que remplaçaient jusqu'ici trois boutons de liste (« Démarrer », « Terminer »,
 * « Projet ») qui n'apprenaient rien à personne : la tâche restait affichée « à faire » pendant
 * deux semaines parce que personne n'avait cliqué sur celui du milieu, et le travail réel — les
 * pièces, le compte rendu — n'avait nulle part où atterrir.
 *
 * Ici tout tient sur une page : ce qui est demandé, par qui, pour quand ; ce qu'on dépose ;
 * ce qu'on répond. Et la validation reste modifiable — on valide en fin de journée, on retrouve
 * une pièce le lendemain.
 */
export default async function TaskDossierPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("WORKSPACE");

  const task = await prisma.task.findUnique({
    where: { id: params.id },
    include: {
      assignedTo: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });
  if (!task) notFound();
  if (!canSee(task, user.id, hasGlobalView(user.role))) notFound();

  const [documents, circle, comments] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "TASK", entityId: task.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { id: { in: [...task.participantIds, ...task.readerIds] } },
      select: { id: true, name: true },
    }),
    // Le fil dans l'ORDRE DE LECTURE : le plus ancien en haut. Un échange se lit comme une
    // conversation, pas comme un journal d'incidents.
    prisma.taskComment.findMany({
      where: { taskId: task.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
  ]);

  const commentItems: TaskCommentItem[] = comments.map((c) => ({
    id: c.id,
    author: c.author?.name ?? "Compte supprimé",
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    mine: c.authorId === user.id,
  }));

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  const nameOf = (id: string) => circle.find((u) => u.id === id)?.name ?? null;
  const participants = task.participantIds.map(nameOf).filter(Boolean).join(", ");
  const readers = task.readerIds.map(nameOf).filter(Boolean).join(", ");

  const request = isRequest(task);
  const mayWork = canDoWork(task, user.id);
  const mayAttach = canAttach(task, user.id);
  const mayRespond = canRespond(task, user.id);
  const mayComment = canComment(task, user.id, hasGlobalView(user.role));

  // Le fil de la demande : chaque étape porte SON horodatage. C'est ce qu'on relit trois
  // semaines plus tard quand quelqu'un demande « ça a été fait quand ? ».
  const timeline: { label: string; at: Date | null; note?: string }[] = [
    { label: request ? "Demande envoyée" : "Tâche créée", at: task.requestedAt ?? task.createdAt },
    ...(task.respondedAt
      ? [{
          label: task.status === "DECLINED" ? "Refusée" : "Acceptée",
          at: task.respondedAt,
          note: task.status === "DECLINED" ? declineSummary(task.declineReason) : undefined,
        }]
      : []),
    ...(task.completedAt ? [{ label: "Travail validé", at: task.completedAt }] : []),
  ];

  return (
    <div className="space-y-5">
      <BackLink href="/mon-espace"><ArrowLeft className="h-4 w-4" /> Mon espace</BackLink>

      <PageHeader
        title={task.title}
        description={request ? requestStage(task) : "Tâche de votre espace de travail"}
      >
        <StatusBadge map={TASK_STATUS} value={task.status} />
        <Badge tone={PRIORITY[task.priority]?.tone ?? "neutral"} dot={false}>
          {PRIORITY[task.priority]?.label ?? task.priority}
        </Badge>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Ce qui est demandé</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Field label="Demandé par" icon={<User2 className="h-3.5 w-3.5" />}>{task.createdBy?.name ?? "—"}</Field>
              <Field label="Chargé de la tâche">{task.assignedTo?.name ?? "—"}</Field>
              <Field label="Pour le" icon={<CalendarClock className="h-3.5 w-3.5" />}>
                {task.dueDate ? formatDate(task.dueDate) : "Sans échéance"}
              </Field>
              {task.description && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Détails</p>
                  <p className="whitespace-pre-wrap break-words">{task.description}</p>
                </div>
              )}
              {task.address && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Lieu</p>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(task.address)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex max-w-full items-start gap-1 font-medium text-primary [overflow-wrap:anywhere] hover:underline"
                  >
                    <MapPin className="mt-1 h-3.5 w-3.5 shrink-0" /> {task.address}
                  </a>
                </div>
              )}
              {(participants || readers) && (
                <div className="col-span-2 sm:col-span-3 text-xs text-muted-foreground">
                  {participants && <>Participants&nbsp;: {participants}</>}
                  {participants && readers && " · "}
                  {readers && <>Lecture&nbsp;: {readers}</>}
                </div>
              )}
            </CardContent>
          </Card>

          {/* LE TRAVAIL — accepter/refuser, déposer, valider. Un seul endroit, pas un parcours. */}
          <TaskWorkPanel
            id={task.id}
            status={task.status}
            note={task.completionNote}
            canRespond={mayRespond}
            canWork={mayWork}
          />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" /> Pièces
                <span className="text-sm font-normal text-muted-foreground">({documents.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {mayAttach ? (
                <DocumentUpload entityType="TASK" entityId={task.id} categories={["SUPPORTING_DOC", "QUOTE", "INVOICE", "PHOTO", "ID_DOCUMENT", "OTHER"]} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Vous suivez cette tâche en lecture : les pièces se déposent par la personne qui
                  la traite.
                </p>
              )}
              <DocumentList
                documents={docItems}
                canDelete={mayAttach} canEdit={onlyofficeConfigured() && mayAttach} canRename={mayAttach}
                path={`/mon-espace/taches/${task.id}`}
              />
            </CardContent>
          </Card>

          {/* LE FIL, après les pièces : on dépose ce qu'on a fait, puis on en parle. */}
          <TaskComments id={task.id} items={commentItems} canWrite={mayComment} />
        </div>

        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Fil de la demande</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-xs">
            {timeline.map((step, i) => (
              <div key={i} className="border-b border-border pb-2.5 last:border-0 last:pb-0">
                <p className="font-medium text-foreground">{step.label}</p>
                <p className="text-muted-foreground">{step.at ? formatDateTime(step.at) : "—"}</p>
                {step.note && <p className="mt-1 text-muted-foreground">{step.note}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, children, icon }: { label: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">{icon}{label}</p>
      <p className="break-words font-medium">{children}</p>
    </div>
  );
}
