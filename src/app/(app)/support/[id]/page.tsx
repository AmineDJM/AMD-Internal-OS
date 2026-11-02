import { notFound } from "next/navigation";
import { ArrowLeft, LifeBuoy, MessageSquare, Paperclip } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getSupportRequest, canViewSupport, isSupportResponder } from "@/lib/queries/support";
import { formatDate, formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { SUPPORT_CATEGORY, SUPPORT_STATUS, PRIORITY, ROLE_LABELS } from "@/lib/labels";
import { SupportActions, SupportMessageForm } from "./panel";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const SUPPORT_DOC_CATEGORIES = ["PROGRAM", "SUPPORTING_DOC", "OTHER"];

export default async function SupportDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  const r = await getSupportRequest(params.id);
  if (!r) notFound();
  if (!canViewSupport(user, r)) notFound();

  const responder = isSupportResponder(user, r);
  const requester = r.requesterId === user.id;
  const target = r.targetUser?.name ?? (r.targetRole ? (ROLE_LABELS[r.targetRole] ?? r.targetRole) : "—");
  const closed = r.status === "CLOSED";

  const documents = await prisma.document.findMany({
    where: { entityType: "SUPPORT_REQUEST", entityId: r.id },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));
  const canUpload = userCan(user, "SUPPORT", "UPLOAD") && (responder || requester);

  return (
    <div className="space-y-5">
      <BackLink href="/support">
        <ArrowLeft className="h-4 w-4" /> Retour aux demandes de support
      </BackLink>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-start gap-2">
            <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{r.subject}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{r.reference}</span> · de {r.requester?.name ?? "—"} → {target}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge map={SUPPORT_CATEGORY} value={r.category} dot={false} />
            <StatusBadge map={SUPPORT_STATUS} value={r.status} />
          </div>
          <SuperAdminDeleteButton kind="SUPPORT_REQUEST" id={r.id} name={`${r.reference} — ${r.subject}`} enabled={user.role === "SUPER_ADMIN"} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Demande</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                <span>Priorité : {PRIORITY[r.priority]?.label ?? r.priority}</span>
                {r.product && <span>Produit : {r.product}</span>}
                <span>Émise le {formatDate(r.createdAt.toISOString())}</span>
                {r.assignedTo && <span>Prise en charge par {r.assignedTo.name}</span>}
              </div>
            </CardContent>
          </Card>

          {/* Fil d'échange */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MessageSquare className="h-4 w-4" /> Échanges</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {r.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune réponse pour l'instant.</p>
              ) : (
                <ul className="space-y-3">
                  {r.messages.map((m) => {
                    const mine = m.authorId === user.id;
                    return (
                      <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div className={`min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[80%] ${mine ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
                          <p className="whitespace-pre-wrap break-words">{m.body}</p>
                          <p className={`mt-1 text-[0.6875rem] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{m.author?.name ?? "—"} · {formatDateTime(m.createdAt.toISOString())}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!closed && <SupportMessageForm id={r.id} />}
            </CardContent>
          </Card>

          {/* Pièces jointes (brochures, supports, PDF…) */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Paperclip className="h-4 w-4" /> Pièces jointes</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <DocumentList documents={docItems} canDelete={canUpload && !closed} canEdit={onlyofficeConfigured() && canUpload && !closed} path={`/support/${r.id}`} />
              {canUpload && !closed && <DocumentUpload entityType="SUPPORT_REQUEST" entityId={r.id} categories={SUPPORT_DOC_CATEGORIES} />}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle className="text-base">Suivi</CardTitle></CardHeader>
            <CardContent>
              <SupportActions id={r.id} status={r.status} isResponder={responder} isRequester={requester} assigned={Boolean(r.assignedToId)} />
              {!responder && !closed && (
                <p className="mt-3 text-xs text-muted-foreground">Le destinataire traitera votre demande et pourra joindre les pièces demandées.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
