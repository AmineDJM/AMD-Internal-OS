import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ClipboardList, MessageSquare, Paperclip } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getDossier, canViewDossier, isDossierMember, canManageDossier } from "@/lib/queries/dossiers";
import { formatDate, formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { DOSSIER_STATUS, PRIORITY } from "@/lib/labels";
import { DossierStatusControls, DossierAssign, DossierMessageForm, DossierMessageItem } from "./panel";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const DOSSIER_DOC_CATEGORIES = ["SUPPORTING_DOC", "PRESENTATION", "QUOTE", "ANALYSIS_CERTIFICATE", "OTHER"];

export default async function DossierDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  const d = await getDossier(params.id);
  if (!d) notFound();
  if (!canViewDossier(user, d)) notFound();

  const manage = canManageDossier(user, d);
  const member = isDossierMember(user, d);
  const archived = d.status === "ARCHIVED";

  const [documents, allUsers] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "DOSSIER", entityId: d.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    manage ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);

  const docItems: DocItem[] = documents.map((doc) => ({
    id: doc.id, name: doc.name, category: doc.category, version: doc.version, sizeBytes: doc.sizeBytes,
    confidentiality: doc.confidentiality, uploadedBy: doc.uploadedBy?.name ?? null,
    createdAt: doc.createdAt.toISOString(), hasFile: Boolean(doc.fileKey),
  }));

  const participants = d.participantIds.length
    ? await prisma.user.findMany({ where: { id: { in: d.participantIds } }, select: { id: true, name: true } })
    : [];
  const participantNames = participants.map((u) => u.name);
  // Membres du dossier = créateur + responsable + participants : seuls mentionnables (@) dans le chat.
  const members = [
    ...(d.createdBy ? [{ id: d.createdBy.id, name: d.createdBy.name }] : []),
    ...(d.assignedTo ? [{ id: d.assignedTo.id, name: d.assignedTo.name }] : []),
    ...participants,
  ].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const canUpload = userCan(user, "DOSSIERS", "UPLOAD") && member;

  return (
    <div className="space-y-5">
      <BackLink href="/dossiers">
        <ArrowLeft className="h-4 w-4" /> Retour aux sujets
      </BackLink>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-start gap-2">
            <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{d.title}</h1>
          </div>
          <p className="break-words text-sm text-muted-foreground">
            <span className="font-mono">{d.reference}</span> · ouvert par {d.createdBy?.name ?? "—"}
            {d.assignedTo && <> · responsable {d.assignedTo.name}</>}
          </p>
          {/* L'ENTITÉ DU SUJET (§118.163) — et, sans elle, ce qui manque et qui le règle. */}
          <p className="text-xs text-muted-foreground">
            Entité : {d.company ? (d.company.shortName || d.company.name) : <span className="text-warning">à renseigner — le Super Admin la rattache depuis Administration › Entités</span>}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:shrink-0 sm:items-end">
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {d.category && <Badge tone="neutral" dot={false}>{d.category}</Badge>}
            <StatusBadge map={DOSSIER_STATUS} value={d.status} />
          </div>
          <SuperAdminDeleteButton kind="DOSSIER" id={d.id} name={`${d.reference} — ${d.title}`} enabled={user.role === "SUPER_ADMIN"} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Sujet</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {d.description ? (
                <p className="whitespace-pre-wrap break-words text-sm">{d.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Aucune description.</p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                <span>Priorité : {PRIORITY[d.priority]?.label ?? d.priority}</span>
                <span>Ouvert le {formatDate(d.createdAt.toISOString())}</span>
                {d.dueDate && <span>Échéance : {formatDate(d.dueDate.toISOString())}</span>}
                {participantNames.length > 0 && <span>Participants : {participantNames.join(", ")}</span>}
              </div>
            </CardContent>
          </Card>

          {/* Fil de discussion */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MessageSquare className="h-4 w-4" /> Suivi & discussion</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {d.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun échange pour l'instant.</p>
              ) : (
                <ul className="space-y-3">
                  {d.messages.map((m) => {
                    const mine = m.authorId === user.id;
                    return (
                      <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <DossierMessageItem
                          id={m.id}
                          body={m.body}
                          author={m.author?.name ?? "—"}
                          createdAt={formatDateTime(m.createdAt.toISOString())}
                          mine={mine}
                          canManage={mine || manage}
                          attachments={m.attachments}
                          mentionNames={m.mentionIds.map((uid) => memberName.get(uid)).filter((n): n is string => Boolean(n))}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              {member && !archived && <DossierMessageForm id={d.id} members={members} />}
            </CardContent>
          </Card>

          {/* Pièces (PPT, Excel, PDF, e-mails…) */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Paperclip className="h-4 w-4" /> Pièces & fichiers</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <DocumentList documents={docItems} canDelete={(manage || canUpload) && !archived} canEdit={onlyofficeConfigured() && canUpload && !archived} path={`/dossiers/${d.id}`} />
              {canUpload && !archived && <DocumentUpload entityType="DOSSIER" entityId={d.id} categories={DOSSIER_DOC_CATEGORIES} />}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle className="text-base">Pilotage</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <DossierStatusControls id={d.id} status={d.status} canManage={manage} />
              {manage && (
                <DossierAssign id={d.id} users={allUsers} currentAssignee={d.assignedToId} currentParticipants={d.participantIds} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
