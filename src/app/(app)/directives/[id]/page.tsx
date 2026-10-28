import { notFound } from "next/navigation";
import { ArrowLeft, Megaphone, Clock, MessageSquare, Paperclip, BellRing, ShieldCheck, Users } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { getDirective, canViewDirective, getDirectiveContext } from "@/lib/queries/directives";
import { formatDate, formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { DIRECTIVE_STATUS, PRIORITY, ROLE_LABELS } from "@/lib/labels";
import { StatusActions, MessageForm, PublishPanel, ResendButton } from "./panel";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { BackLink } from "@/components/shared/back-link";
import { canPublishDirectives, describeAudience, describeSends, PUBLICATION_LABELS } from "@/lib/directives/audience";

export const dynamic = "force-dynamic";

const PUBLICATION_TONE = {
  DRAFT: "neutral", PENDING_APPROVAL: "warning", PUBLISHED: "success", REJECTED: "danger",
} as const;

/** Taille lisible d'une pièce — « 2,4 Mo » se comprend, « 2516582 » non. */
function poids(bytes: number | null): string {
  if (!bytes) return "";
  const mo = bytes / 1_048_576;
  return mo >= 1 ? `${mo.toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

export default async function DirectiveDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  const d = await getDirective(params.id);
  if (!d) notFound();
  if (!(await canViewDirective(user, d))) notFound();

  const canManage = hasGlobalView(user.role) || userCan(user, "DIRECTIVES", "CREATE");
  const canPublish = canPublishDirectives({ id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null });
  const { attachments, recipientCount, namedRecipients } = await getDirectiveContext(d);
  const portee = describeAudience(
    { audience: d.audience, targetUserIds: d.targetUserIds, targetRole: d.targetRole, companyId: d.companyId },
    {
      users: namedRecipients.map((u) => u.name),
      role: d.targetRole ? (ROLE_LABELS[d.targetRole] ?? d.targetRole) : null,
      company: d.company?.name ?? null,
      count: d.audience === "USERS" ? undefined : recipientCount,
    },
  );

  return (
    <div className="space-y-5">
      <BackLink href="/directives">
        <ArrowLeft className="h-4 w-4" /> Retour aux directives
      </BackLink>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-start gap-2">
            <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{d.title}</h1>
          </div>
          <p className="break-words text-sm text-muted-foreground">
            <span className="font-mono">{d.reference}</span> · de {d.from?.name ?? "Direction"} → {portee}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:shrink-0 sm:items-end">
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {d.publication !== "PUBLISHED" && (
              <Badge tone={PUBLICATION_TONE[d.publication]}>{PUBLICATION_LABELS[d.publication]}</Badge>
            )}
            {d.popup && <Badge tone="info"><BellRing className="h-3 w-3" /> pop-up</Badge>}
            <StatusBadge map={PRIORITY} value={d.priority} dot={false} />
            <StatusBadge map={DIRECTIVE_STATUS} value={d.status} />
          </div>
          <SuperAdminDeleteButton kind="DIRECTIVE" id={d.id} name={`${d.reference} — ${d.title}`} enabled={user.role === "SUPER_ADMIN"} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Directive</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="whitespace-pre-wrap break-words text-sm">{d.body}</p>

              {/* LA PIÈCE JOINTE S'OUVRE ICI — la note de service EST souvent le document. */}
              {attachments.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-border bg-secondary/40 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <Paperclip className="h-3.5 w-3.5 text-primary" />
                    {attachments.length} pièce{attachments.length > 1 ? "s" : ""} jointe{attachments.length > 1 ? "s" : ""}
                  </p>
                  <ul className="space-y-1">
                    {attachments.map((a) => (
                      <li key={a.id}>
                        <a
                          href={`/api/documents/${a.id}`} target="_blank" rel="noreferrer"
                          className="inline-flex max-w-full items-start gap-2 py-1 text-sm text-primary [overflow-wrap:anywhere] hover:underline"
                        >
                          <Paperclip className="mt-1 h-3.5 w-3.5 shrink-0" /> {a.name}
                          {a.sizeBytes ? <span className="text-xs text-muted-foreground">({poids(a.sizeBytes)})</span> : null}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                <span>Émise le {formatDate(d.createdAt.toISOString())}</span>
                {d.publishedAt && <span>Publiée le {formatDate(d.publishedAt.toISOString())}{d.approvedBy?.name ? ` par ${d.approvedBy.name}` : ""}</span>}
                {d.dueDate && <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Échéance {formatDate(d.dueDate.toISOString())}</span>}
                {d.acknowledgedAt && <span>Pris en compte le {formatDate(d.acknowledgedAt.toISOString())}</span>}
              </div>

              {d.publication === "REJECTED" && d.decisionNote && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  Refusée par {d.approvedBy?.name ?? "la direction générale"} — {d.decisionNote}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Espace d'échange */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MessageSquare className="h-4 w-4" /> Échanges</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {d.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun échange pour l&apos;instant.</p>
              ) : (
                <ul className="space-y-3">
                  {d.messages.map((m) => {
                    const mine = m.authorId === user.id;
                    return (
                      <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[88%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[80%] ${mine ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
                          <p className="whitespace-pre-wrap break-words">{m.body}</p>
                          <p className={`mt-1 text-[0.6875rem] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                            {m.author?.name ?? "—"} · {formatDateTime(m.createdAt.toISOString())}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {d.status !== "ARCHIVED" && d.publication === "PUBLISHED" && <MessageForm id={d.id} />}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          {/* LA PORTE DE PUBLICATION — visible de la seule direction générale, et seulement
              tant que la note n'est pas partie. */}
          {canPublish && d.publication !== "PUBLISHED" && (
            <Card className="border-warning/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4 text-warning" /> Validation de la direction
                </CardTitle>
              </CardHeader>
              <CardContent>
                <PublishPanel id={d.id} recipientCount={recipientCount} popup={d.popup} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="text-base">Diffusion</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-start gap-2">
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="break-words font-medium">{portee}</p>
                  <p className="text-xs text-muted-foreground">
                    {recipientCount} destinataire{recipientCount > 1 ? "s" : ""}
                    {d.popup ? " · pop-up plein écran" : " · notification"}
                  </p>
                </div>
              </div>
              {(canPublish || d.fromId === user.id) && d.publication === "PUBLISHED" && (
                <ResendButton id={d.id} hint={describeSends(d.sendCount, d.lastSentAt)} />
              )}
            </CardContent>
          </Card>

          {d.publication === "PUBLISHED" && (
            <Card>
              <CardHeader><CardTitle className="text-base">Suivi</CardTitle></CardHeader>
              <CardContent>
                <StatusActions id={d.id} status={d.status} canManage={canManage} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
