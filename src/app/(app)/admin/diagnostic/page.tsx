import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ADMIN_TABS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { runDiagnostic, type Severity, type Finding } from "@/lib/platform-audit/engine";
import { lireSanteTachesDeFond } from "@/lib/taches-de-fond/sante";
import { PlatformIdeas } from "./diagnostic-client";
import { TachesDeFondCard } from "./taches-de-fond";

export const metadata = { title: "Diagnostic — AMD Internal OS" };
export const dynamic = "force-dynamic";

const SEV: Record<Severity, { label: string; icon: string; cls: string; dot: string }> = {
  critical: { label: "Critique", icon: "OctagonAlert", cls: "border-destructive/30 bg-destructive/5", dot: "text-destructive" },
  warning: { label: "À surveiller", icon: "TriangleAlert", cls: "border-amber-500/30 bg-amber-500/5", dot: "text-amber-600" },
  info: { label: "Info", icon: "Info", cls: "border-blue-500/30 bg-blue-500/5", dot: "text-blue-600" },
  ok: { label: "OK", icon: "CheckCircle2", cls: "border-emerald-500/30 bg-emerald-500/5", dot: "text-emerald-600" },
};

function scoreColor(s: number): string {
  if (s >= 85) return "text-emerald-600";
  if (s >= 60) return "text-amber-600";
  return "text-destructive";
}

export default async function DiagnosticPage() {
  const admin = await requireModule("ADMIN", "UPDATE");
  if (admin.role !== "SUPER_ADMIN") redirect("/admin");

  const [d, sante] = await Promise.all([runDiagnostic(), lireSanteTachesDeFond({ detail: true })]);
  const bySev = (s: Severity) => d.findings.filter((f) => f.severity === s);
  const crit = bySev("critical"), warn = bySev("warning"), info = bySev("info");

  return (
    <div className="space-y-5">
      <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(admin, t.module, "VIEW") }))} />

      {/* En-tête : score de santé + sondes */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Santé de la plateforme</CardTitle>
            <CardDescription>Diagnostic calculé en direct sur les données réelles.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <span className={cn("text-5xl font-bold tabular-nums", scoreColor(d.healthScore))}>{d.healthScore}</span>
              <span className="pb-1.5 text-sm text-muted-foreground">/ 100</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <Badge tone={crit.length ? "danger" : "neutral"} dot={false}>{crit.length} critique(s)</Badge>
              <Badge tone={warn.length ? "warning" : "neutral"} dot={false}>{warn.length} à surveiller</Badge>
              <Badge tone="neutral" dot={false}>{info.length} info(s)</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Sondes système</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {d.probes.map((p) => (
              <div key={p.key} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <Icon name={p.ok ? "CircleCheck" : "CircleX"} className={cn("h-4 w-4 shrink-0", p.ok ? "text-emerald-600" : "text-destructive")} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{p.label}</p>
                  <p className="line-clamp-2 break-words text-[0.6875rem] text-muted-foreground">{p.value}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Battement des tâches de fond (V2-F) : web ou worker, dernier passage, durée, issue */}
      <TachesDeFondCard sante={sante} />

      {/* Idées IA (bouton) */}
      <PlatformIdeas hasFindings={d.findings.length > 0} />

      {/* Constats */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Constats ({d.findings.length})</CardTitle>
          <CardDescription>Base, rôles, files d'attente, formats de fichiers, navigation, IA, environnement.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {d.findings.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-600"><Icon name="CheckCircle2" className="h-4 w-4" /> Aucun problème détecté — tout est cohérent.</p>
          ) : d.findings.map((f: Finding, i) => (
            <div key={i} className={cn("rounded-lg border p-3", SEV[f.severity].cls)}>
              <div className="flex items-start gap-2.5">
                <Icon name={SEV[f.severity].icon} className={cn("mt-0.5 h-4 w-4 shrink-0", SEV[f.severity].dot)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{f.title}</span>
                    <Badge tone="neutral" dot={false} className="text-[0.6875rem]">{f.area}</Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{f.detail}</p>
                  {f.suggestion && <p className="mt-1 text-xs text-foreground/80"><span className="font-medium">Piste :</span> {f.suggestion}</p>}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Formats de fichiers acceptés par espace */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Formats de fichiers par espace</CardTitle>
          <CardDescription>Testé en direct sur les validateurs réels (accepté / refusé).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.uploads.map((u) => (
            <div key={u.key} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{u.label}</p>
                <span className="text-xs text-muted-foreground">{u.strategy === "allowlist" ? "liste blanche" : "tout sauf exécutables"} · max {u.maxMb} Mo</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {u.accepted.map((x) => <span key={x} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[0.6875rem] text-emerald-700">.{x}</span>)}
                {u.rejected.map((x) => <span key={x} className="rounded bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] text-destructive line-through">.{x}</span>)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Rôles + volumétrie */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Couverture des rôles clés</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {d.roles.map((r) => (
              <div key={r.role} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{r.label}</span>
                <Badge tone={r.active === 0 ? (r.critical ? "danger" : "warning") : "success"} dot={false}>{r.active} actif(s)</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Volumétrie (données réelles)</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {d.moduleStats.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-muted-foreground">{s.label}</span>
                <span className="font-semibold tabular-nums">{s.count < 0 ? "—" : s.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Repères ergonomie & structure (référentiels Apple / Fluent / Lightning) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Repères ergonomie & structure</CardTitle>
          <CardDescription>Densité de navigation, clarté des rôles, cohérence, temps de réponse — nourrissent la revue de design IA.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: "Entrées de menu", v: `${d.design.menuTopLevel} (${d.design.menuTotal} avec onglets)` },
            { k: "Rôles", v: `${d.design.roleCount}` },
            { k: "Modules/rôle (moy.)", v: `${d.design.roleModules.avg}` },
            { k: "Rôles au périmètre identique", v: `${d.design.redundantRoleGroups.length}` },
            { k: "Politiques d'upload", v: `${d.design.uploadPolicies}` },
            { k: "Temps requête type", v: `${d.design.sampleQueryMs} ms` },
          ].map((x) => (
            <div key={x.k} className="rounded-lg border border-border p-2.5">
              <p className="text-lg font-semibold tabular-nums">{x.v}</p>
              <p className="text-[0.6875rem] text-muted-foreground">{x.k}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Les axes navigateur (responsivité multi-écrans, temps de chargement, perte de connexion, accessibilité clavier)
        se mesurent avec le crawl <code className="rounded bg-muted px-1">npm run autotest:live</code> — le bouton « Idées » ci-dessus en tient compte.
      </p>
    </div>
  );
}
