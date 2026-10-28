import Link from "next/link";
import { ArrowRight, Megaphone, MessageSquare, Clock, Paperclip, BellRing } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { getDirectives } from "@/lib/queries/directives";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { createDirective } from "@/lib/actions/directive-actions";
import { DIRECTIVE_STATUS, PRIORITY, ROLE_LABELS } from "@/lib/labels";
import { canIssueDirective } from "@/lib/directives/access";
import { AUDIENCE_LABELS, canPublishDirectives, describeAudience } from "@/lib/directives/audience";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

/** Pastille de publication — l'axe qui dit si la note est PARTIE, distinct de son traitement. */
const PUBLICATION_TONE = {
  DRAFT: { label: "Brouillon", tone: "neutral" as const },
  PENDING_APPROVAL: { label: "En attente de validation", tone: "warning" as const },
  PUBLISHED: { label: "Publiée", tone: "success" as const },
  REJECTED: { label: "Refusée", tone: "danger" as const },
};

export default async function DirectivesPage() {
  const user = await requireModule("DIRECTIVES");
  const settings = await getAppSettings().catch(sansBloquer("directives-page.DirectivesPage.getAppSettings", null));
  const access = {
    directiveReaderRoles: settings?.directiveReaderRoles ?? [],
    directiveReaderUserIds: settings?.directiveReaderUserIds ?? [],
    directiveIssuerRoles: settings?.directiveIssuerRoles ?? [],
    directiveIssuerUserIds: settings?.directiveIssuerUserIds ?? [],
  };
  const me = { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null };
  const canManage = hasGlobalView(user.role)
    || canIssueDirective(me, access, userCan(user, "DIRECTIVES", "CREATE"));
  const canPublish = canPublishDirectives(me);

  const [directives, users, companies] = await Promise.all([
    getDirectives(user),
    canManage ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    canManage ? prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }) : Promise.resolve([]),
  ]);

  const roleOptions = [
    { value: "", label: "— (selon la portée choisie) —" },
    ...Object.entries(ROLE_LABELS).filter(([v]) => v !== "SUPER_ADMIN").map(([v, l]) => ({ value: v, label: l })),
  ];
  const companyOptions = [
    { value: "", label: "— (selon la portée choisie) —" },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  const attente = directives.filter((d) => d.publication === "PENDING_APPROVAL");
  const active = directives.filter((d) => d.status !== "ARCHIVED" && d.status !== "DONE");

  return (
    <div className="space-y-5">
      <PageHeader title="Directives" description="Notes de service de la Direction vers les équipes, avec un espace d'échange et un suivi. La publication est prononcée par la direction générale.">
        {canManage && (
          <CreateRecordButton
            label="Nouvelle directive"
            title="Émettre une directive"
            description={canPublish
              ? "Choisissez la portée : une ou plusieurs personnes, un rôle, une entité, ou toute l'entreprise. Elle partira dès la création."
              : "Choisissez la portée, joignez la pièce s'il y en a une. La note partira une fois validée par la direction générale."}
            action={createDirective}
            redirectBase="/directives"
            fields={[
              { type: "text", name: "title", label: "Objet", required: true },
              { type: "textarea", name: "body", label: "Directive (contenu)", required: true },
              { type: "select", name: "priority", label: "Priorité", options: optionsFromMap(PRIORITY), defaultValue: "MEDIUM" },
              { type: "date", name: "dueDate", label: "Échéance (optionnel)" },
              {
                type: "select", name: "audience", label: "Portée de la diffusion",
                options: Object.entries(AUDIENCE_LABELS).map(([value, label]) => ({ value, label })),
                defaultValue: "USERS", full: true,
              },
              {
                type: "multiselect", name: "targetUserIds", label: "Personnes (portée « une ou plusieurs personnes »)",
                options: users.map((u) => ({ value: u.id, label: `${u.name} — ${ROLE_LABELS[u.role] ?? u.role}` })),
                hint: "Cochez autant de destinataires que nécessaire.", full: true,
              },
              { type: "select", name: "targetRole", label: "Rôle (portée « tous les porteurs d'un rôle »)", options: roleOptions },
              { type: "select", name: "companyId", label: "Entité (portée « tous les salariés d'une entité »)", options: companyOptions },
              {
                type: "file", name: "files", label: "Pièce jointe", multiple: true, full: true,
                hint: "Le document s'ouvre directement depuis la directive — note signée, formulaire, procédure.",
              },
              {
                type: "checkbox", name: "popup", full: true,
                label: "Diffuser en pop-up plein écran (à réserver à ce qui doit être lu tout de suite)",
              },
            ]}
          />
        )}
      </PageHeader>
      {/* Plus d'onglets « Mon espace » ici (Direction, 07/10) : les Directives ne sont plus un onglet de l'espace —
          on y arrive par « Aujourd'hui », le centre d'actions, la recherche ou une notification. */}

      {canPublish && attente.length > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex items-start gap-3 py-3 text-sm sm:items-center">
            <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-warning sm:mt-0" />
            <span>
              <strong>{attente.length} directive{attente.length > 1 ? "s" : ""}</strong> attend{attente.length > 1 ? "ent" : ""} votre
              validation — rien ne part avant votre accord.
            </span>
          </CardContent>
        </Card>
      )}

      {directives.length === 0 ? (
        <EmptyState icon="Megaphone" title="Aucune directive" description={canManage ? "Émettez une directive pour vos équipes." : "Les directives de la Direction qui vous concernent apparaîtront ici."} />
      ) : (
        <Card>
          <div className="divide-y divide-border">
            {directives.map((d) => (
              <Link key={d.id} href={`/directives/${d.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 transition-colors hover:bg-secondary/50 sm:flex-nowrap sm:gap-4 sm:px-4">
                <Megaphone className="h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{d.reference}</span>
                    <span className="truncate font-medium">{d.title}</span>
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>→ {describeAudience(
                      { audience: d.audience, targetUserIds: d.targetUserIds, targetRole: d.targetRole, companyId: d.companyId },
                      {
                        users: d.targetUser?.name ? [d.targetUser.name] : undefined,
                        role: d.targetRole ? (ROLE_LABELS[d.targetRole] ?? d.targetRole) : null,
                        company: d.company?.shortName ?? d.company?.name ?? null,
                      },
                    )}</span>
                    <span>· {formatDate(d.createdAt.toISOString())}</span>
                    {d._count.messages > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {d._count.messages}</span>}
                    {d.dueDate && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {formatDate(d.dueDate.toISOString())}</span>}
                    {d.popup && <span className="inline-flex items-center gap-1"><BellRing className="h-3 w-3" /> pop-up</span>}
                  </p>
                </div>
                {/* Au téléphone, les pastilles passent sous le texte (alignées sur lui) au lieu de l'écraser. */}
                <div className="flex basis-full flex-wrap items-center gap-2 pl-8 sm:basis-auto sm:shrink-0 sm:flex-nowrap sm:pl-0">
                  {d.publication !== "PUBLISHED" && (
                    <Badge tone={PUBLICATION_TONE[d.publication].tone}>{PUBLICATION_TONE[d.publication].label}</Badge>
                  )}
                  <StatusBadge map={PRIORITY} value={d.priority} dot={false} />
                  <StatusBadge map={DIRECTIVE_STATUS} value={d.status} />
                  <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {canManage && active.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Paperclip className="h-3 w-3" /> {active.length} directive(s) en cours de traitement.
        </p>
      )}
    </div>
  );
}
