import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ArrowLeft, Users, Sparkles, ListChecks, CircleUser, MapPin, MessageSquare } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { publicMeetUrl, appBaseUrlForMeet, canViewMeeting, canManageMeeting } from "@/lib/meetings";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MeetJoin } from "./meet-join";
import { formatAlgiers, utcToAlgiersInput } from "@/lib/calendar-tz";

const formatDateTime = (d: Date) => formatAlgiers(d, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
import { ProposalActions, ShareLink, ManageBar } from "./meeting-panels";
import { InviteResponse } from "./invite-response";
import { MeetingChat, type ChatMessage } from "./meeting-chat";
import { ManageParticipants } from "./manage-participants";
import { EditMeetingButton } from "../edit-meeting-button";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { StatusBadge } from "@/components/shared/status-badge";
import { CALENDAR_INVITE_STATUS } from "@/lib/labels";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = {
  LIVE: { label: "En cours", tone: "success" },
  SCHEDULED: { label: "Planifiée", tone: "warning" },
  ENDED: { label: "Terminée", tone: "neutral" },
};

async function externalBase(): Promise<string> {
  const fromEnv = appBaseUrlForMeet();
  if (fromEnv) return fromEnv;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

export default async function MeetingDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("MESSAGING");

  const meeting = await prisma.meeting.findUnique({
    where: { id: params.id },
    include: {
      organizer: { select: { id: true, name: true } },
      participants: { include: { user: { select: { id: true, name: true, title: true } } } },
      proposals: { include: { assignee: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      messages: {
        include: { author: { select: { id: true, name: true } }, attachments: { select: { id: true, name: true, mime: true, size: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!meeting) notFound();
  if (!canViewMeeting(user, meeting)) notFound();
  const canManage = canManageMeeting(user, meeting);
  // Le participant courant (invité), pour lui proposer d'accepter / refuser (façon agenda).
  const myParticipant = meeting.participants.find((p) => p.userId === user.id);
  // Personnes que l'organisateur peut inviter (tous les comptes actifs sauf l'organisateur).
  const allUsers = canManage
    ? (await prisma.user.findMany({
        where: { isActive: true, id: { not: meeting.organizerId } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }))
    : [];

  // Fil de discussion (chat) : suppression pour l'auteur ou l'organisateur/vue globale.
  const chatMessages: ChatMessage[] = meeting.messages.map((m) => ({
    id: m.id,
    body: m.body,
    author: m.author?.name ?? "Utilisateur",
    createdAt: formatDateTime(m.createdAt),
    mine: m.authorId === user.id,
    canDelete: m.authorId === user.id || canManage,
    attachments: m.attachments,
  }));

  const base = await externalBase();
  const shareUrl = base ? publicMeetUrl(meeting.publicToken, base) : "";
  const openProposals = meeting.proposals.filter((p) => p.status === "PROPOSED");
  const acceptedCount = meeting.proposals.filter((p) => p.status === "ACCEPTED").length;

  return (
    <div className="space-y-5">
      <BackLink href="/meetings">
        <ArrowLeft className="h-4 w-4" /> Réunions
      </BackLink>

      <PageHeader title={meeting.title} description={meeting.description ?? undefined}>
        <Badge tone={STATUS[meeting.status]?.tone ?? "neutral"} dot={false}>{STATUS[meeting.status]?.label ?? meeting.status}</Badge>
        {/* L'organisateur peut modifier SA réunion à TOUT MOMENT — y compris une réunion
            terminée (corriger l'intitulé, replanifier…). L'action serveur l'autorise déjà. */}
        {canManage && (
          <EditMeetingButton
            id={meeting.id}
            title={meeting.title}
            description={meeting.description ?? ""}
            meetLink={meeting.meetLink ?? ""}
            scheduledAtInput={meeting.scheduledAt ? utcToAlgiersInput(meeting.scheduledAt) : ""}
            withVideo={meeting.withVideo}
            inPerson={meeting.inPerson}
            location={meeting.location ?? ""}
          />
        )}
        {canManage && <ManageBar meetingId={meeting.id} status={meeting.status} />}
        <SuperAdminDeleteButton kind="MEETING" id={meeting.id} name={meeting.title} enabled={user.role === "SUPER_ADMIN"} />
      </PageHeader>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {myParticipant && meeting.status !== "ENDED" && (
            <InviteResponse meetingId={meeting.id} current={myParticipant.response} />
          )}
          {meeting.inPerson ? (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" /> Réunion en présentiel</CardTitle></CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{meeting.location || "Lieu à préciser par l'organisateur."}</p>
              </CardContent>
            </Card>
          ) : (
            <MeetJoin meetingId={meeting.id} meetLink={meeting.meetLink} canManage={canManage} />
          )}

          {/* Fil de discussion (chat) — texte + pièces jointes, comme les autres discussions */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-primary" /> Discussion</CardTitle></CardHeader>
            <CardContent>
              <MeetingChat meetingId={meeting.id} messages={chatMessages} />
            </CardContent>
          </Card>

          {/* Compte rendu IA */}
          {meeting.summary && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Compte rendu</CardTitle></CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{meeting.summary}</p>
              </CardContent>
            </Card>
          )}

          {/* Tâches proposées */}
          {(openProposals.length > 0 || acceptedCount > 0) && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-primary" /> Tâches proposées</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {openProposals.map((p) => (
                  <div key={p.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium [overflow-wrap:anywhere]">{p.title}</p>
                      {p.description && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.description}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">Pour : {p.assignee?.name ?? "à assigner (organisateur)"}</p>
                    </div>
                    {canManage && <ProposalActions proposalId={p.id} />}
                  </div>
                ))}
                {acceptedCount > 0 && (
                  <p className="text-xs text-muted-foreground">{acceptedCount} tâche(s) déjà créée(s) dans « Mon espace ».</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Latéral */}
        <div className="space-y-5">
          {!meeting.inPerson && (
            <Card>
              <CardHeader><CardTitle>Lien externe partageable</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">Partagez ce lien à un invité externe (sans compte, sans limite de temps).</p>
                {shareUrl ? <ShareLink url={shareUrl} /> : <p className="text-xs text-muted-foreground">Définissez <code>APP_URL</code> pour générer un lien absolu.</p>}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Participants</CardTitle>
              {canManage && (
                <ManageParticipants
                  meetingId={meeting.id}
                  participants={meeting.participants.map((p) => ({ id: p.userId, name: p.user?.name ?? "—" }))}
                  allUsers={allUsers}
                />
              )}
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex items-center gap-2">
                <CircleUser className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 truncate font-medium">{meeting.organizer?.name ?? "—"}</span>
                <span className="ml-auto shrink-0"><Badge tone="neutral" dot={false}>Organisateur</Badge></span>
              </div>
              {meeting.participants.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-muted-foreground">
                  <CircleUser className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{p.user?.name ?? "—"}</span>
                  <span className="ml-auto shrink-0"><StatusBadge map={CALENDAR_INVITE_STATUS} value={p.response} dot={false} /></span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Informations</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Format" value={meeting.inPerson ? "Présentiel" : meeting.withVideo ? "En ligne (vidéo)" : "En ligne (audio)"} />
              {meeting.inPerson && meeting.location && <Row label="Lieu" value={meeting.location} />}
              {meeting.scheduledAt && <Row label="Planifiée" value={formatDateTime(meeting.scheduledAt)} />}
              {meeting.startedAt && <Row label="Démarrée" value={formatDateTime(meeting.startedAt)} />}
              {meeting.endedAt && <Row label="Terminée" value={formatDateTime(meeting.endedAt)} />}
              <Row label="Créée" value={formatDateTime(meeting.createdAt)} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{value}</span>
    </div>
  );
}
