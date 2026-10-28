import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { ImpersonateButton } from "./impersonate-button";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, defaultScope, MODULES, ACTIONS, type Action, type Module, regulatoryLockWhere } from "@/lib/rbac";
import { buildAccessSheet, type PermissionMatrix } from "@/lib/rbac-sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { MODULE_LABELS, ROLE_LABELS, ACTION_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/utils";
import { AccessMatrix, type ModuleAccessRow } from "./access-matrix";
import { SessionsList, type SessionItem } from "./sessions-list";
import { RowGrants } from "./row-grants";
import { getAppSettings } from "@/lib/settings";
import { ProfileForm, ResetPasswordForm, ActiveToggle, RevokeAllButton, RequestOnboardingButton } from "./user-admin-forms";
import { BackLink } from "@/components/shared/back-link";
import { sansBloquer } from "@/lib/journal";

const MODULE_LABEL: Record<string, string> = MODULE_LABELS;

/**
 * Ce que chaque module autorise réellement — DÉDUIT de la matrice des rôles et de la portée par
 * défaut, jamais recopié. Une liste écrite à la main propose tôt ou tard une case qui n'ouvre
 * rien, ou oublie un module ajouté depuis.
 */
const SHEET = new Map(
  buildAccessSheet(
    MODULES, MODULE_LABELS as Record<string, string>,
    PERMISSIONS as unknown as PermissionMatrix, ACTIONS,
    Object.keys(PERMISSIONS),
    (role, module) => defaultScope(role as Parameters<typeof defaultScope>[0], module as Module),
  ).map((spec) => [spec.value, spec]),
);

export default async function AdminUserPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const admin = await requireModule("ADMIN", "UPDATE");

  const target = await prisma.user.findUnique({
    where: { id: params.id },
    include: { access: true, department: true },
  });
  if (!target) notFound();

  const [grants, sessions, activity, regProducts, doctors, bdOpps] = await Promise.all([
    prisma.rowGrant.findMany({ where: { userId: target.id } }),
    prisma.userSession.findMany({
      where: { userId: target.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
    }),
    prisma.activityLog.findMany({ where: { userId: target.id }, orderBy: { createdAt: "desc" }, take: 15 }),
    // Le verrou prime sur toute autorisation nominative : proposer un dossier verrouillé ici
    // afficherait son nom ET donnerait une permission qui, de toute façon, ne l'ouvrirait pas.
    prisma.regulatoryProduct.findMany({ where: regulatoryLockWhere(admin), select: { id: true, reference: true, dci: true }, orderBy: { reference: "asc" } }),
    prisma.medicalDoctor.findMany({ select: { id: true, name: true, city: true }, orderBy: { name: "asc" } }),
    prisma.businessDevelopmentOpportunity.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  // Modules HORS SERVICE : un module masqué prime sur tous les droits réglés ici — le dire
  // évite de chercher pourquoi un accès accordé « ne marche pas ».
  const { hiddenModules } = await getAppSettings().catch(sansBloquer("id-page.AdminUserPage.getAppSettings", { hiddenModules: [] as string[] }));
  const hors = new Set(hiddenModules);
  const overrideMap = new Map(target.access.map((a) => [a.module, a]));
  const matrixRows: ModuleAccessRow[] = MODULES.map((module) => {
    const ov = overrideMap.get(module);
    const def = PERMISSIONS[target.role]?.[module] ?? [];
    const roleSummary = def.length
      ? def.filter((a) => a !== "VIEW").map((a) => ACTION_LABELS[a]).join(", ") || "Voir seulement"
      : "Aucun accès";
    let mode: ModuleAccessRow["mode"] = "DEFAULT";
    const actions: Record<string, boolean> = {};
    let scope: "ALL" | "ASSIGNED" = defaultScope(target.role, module);
    if (ov) {
      mode = ov.canView ? "CUSTOM" : "BLOCKED";
      actions.CREATE = ov.canCreate; actions.UPDATE = ov.canUpdate; actions.DELETE = ov.canDelete;
      actions.VALIDATE = ov.canValidate; actions.EXPORT = ov.canExport; actions.UPLOAD = ov.canUpload;
      scope = ov.scope;
    } else {
      for (const a of def) if (a !== "VIEW") actions[a as Action] = true;
    }
    const spec = SHEET.get(module);
    return {
      module, label: MODULE_LABEL[module] ?? module, mode, actions, scope,
      hidden: hors.has(module),
      available: spec?.actions ?? [], rowScoped: spec?.rowScoped ?? false, roleSummary,
      // Les annuaires ne se portent que sur un accès PERSONNALISÉ (§118.147) : ailleurs, rien.
      sections: ov?.canView ? ov.sections : [],
    };
  });

  const sessionItems: SessionItem[] = sessions.map((s) => ({
    id: s.id, device: s.device ?? "desktop", browser: s.browser ?? "—", os: s.os ?? "—",
    ip: s.ipAddress ?? "", location: [s.city, s.country].filter(Boolean).join(", "),
    createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(),
    current: s.id === admin.sid,
  }));

  const grantIds = (type: string) => grants.filter((g) => g.entityType === type).map((g) => g.entityId);

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Retour à l’administration
      </BackLink>

      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={target.name} color={target.avatarColor} size="lg" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{target.name}</h1>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {target.email} · {ROLE_LABELS[target.role] ?? target.role}
            {target.isActive ? (
              <Badge tone="success" dot={false} className="ml-2">Actif</Badge>
            ) : (
              <Badge tone="danger" dot={false} className="ml-2">Inactif</Badge>
            )}
          </p>
        </div>
        {admin.role === "SUPER_ADMIN" && target.isActive && target.id !== admin.id && (
          <ImpersonateButton userId={target.id} />
        )}
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Accès par onglet, action et lignes</CardTitle>
        </CardHeader>
        <CardContent>
          <AccessMatrix userId={target.id} rows={matrixRows} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Profil</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ProfileForm user={{ id: target.id, name: target.name, email: target.email, title: target.title ?? "", region: target.region ?? "", role: target.role }} />
            <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
              <ActiveToggle userId={target.id} isActive={target.isActive} isSelf={target.id === admin.id} />
              <RequestOnboardingButton
                userId={target.id}
                mustOnboard={target.mustOnboard}
                onboardedAt={target.onboardedAt ? target.onboardedAt.toISOString() : null}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Sécurité</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ResetPasswordForm userId={target.id} />
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Sessions actives ({sessionItems.length})</p>
                <RevokeAllButton userId={target.id} />
              </div>
              <SessionsList userId={target.id} sessions={sessionItems} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Accès à des lignes précises</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <RowGrants userId={target.id} entityType="REGULATORY_PRODUCT" title="Dossiers Regulatory"
            options={regProducts.map((p) => ({ id: p.id, label: `${p.reference} — ${p.dci}` }))} selected={grantIds("REGULATORY_PRODUCT")} />
          <RowGrants userId={target.id} entityType="DOCTOR" title="Médecins"
            options={doctors.map((d) => ({ id: d.id, label: `${d.name}${d.city ? " · " + d.city : ""}` }))} selected={grantIds("DOCTOR")} />
          <RowGrants userId={target.id} entityType="BD_OPPORTUNITY" title="Opportunités BD"
            options={bdOpps.map((o) => ({ id: o.id, label: o.name }))} selected={grantIds("BD_OPPORTUNITY")} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Activité récente</CardTitle></CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune activité enregistrée.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {activity.map((a) => (
                <li key={a.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <Badge tone={a.type === "LOGIN" ? "success" : "info"} dot={false}>{a.type}</Badge>
                    <span className="ml-2 text-muted-foreground">{a.path ?? a.module ?? "—"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {[a.browser, a.os].filter(Boolean).join(" · ")}
                    {a.durationMs ? ` · ${Math.round(a.durationMs / 1000)}s` : ""} · {formatDateTime(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
