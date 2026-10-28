import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ADMIN_TABS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { getTestCenterDashboard } from "@/lib/queries/test-center";
import { resolveEnvironment } from "@/lib/test-center/guard";
import { LaunchPanel, ResumeCleanupButton } from "./test-center-client";
import type { TestRunStatus, TestCleanupStatus, TestSeverity, TestCertification } from "@prisma/client";

export const metadata = { title: "Test Center — AMD Internal OS" };
export const dynamic = "force-dynamic";

const STATUS: Record<TestRunStatus, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  PENDING: { label: "En attente", tone: "neutral" },
  RUNNING: { label: "En cours", tone: "warning" },
  PASSED: { label: "Réussi", tone: "success" },
  FAILED: { label: "Échec", tone: "danger" },
  ABORTED: { label: "Interrompu", tone: "warning" },
  CLEANUP_INCOMPLETE: { label: "Nettoyage incomplet", tone: "danger" },
};
const CLEANUP: Record<TestCleanupStatus, string> = { NOT_REQUIRED: "sans objet", PENDING: "en attente", RUNNING: "en cours", DONE: "vérifié ✓", INCOMPLETE: "incomplet ⚠" };
const SEV: Record<TestSeverity, { label: string; cls: string; icon: string }> = {
  CRITICAL: { label: "Critique", cls: "text-destructive", icon: "OctagonAlert" },
  HIGH: { label: "Élevé", cls: "text-destructive", icon: "TriangleAlert" },
  MEDIUM: { label: "Moyen", cls: "text-amber-600", icon: "TriangleAlert" },
  LOW: { label: "Faible", cls: "text-blue-600", icon: "Info" },
  INFO: { label: "Info", cls: "text-blue-600", icon: "Info" },
};
const CERT: Record<TestCertification, { label: string; tone: "neutral" | "success" | "warning" | "danger"; icon: string }> = {
  CERTIFIED: { label: "CERTIFIÉ", tone: "success", icon: "ShieldCheck" },
  CERTIFIED_WITH_RESERVATIONS: { label: "CERTIFIÉ AVEC RÉSERVES", tone: "warning", icon: "ShieldAlert" },
  BLOCKED: { label: "BLOQUÉ", tone: "danger", icon: "ShieldX" },
  INCONCLUSIVE: { label: "NON CONCLUANT", tone: "neutral", icon: "ShieldQuestion" },
};
type Summary = {
  certificationReasons?: string[];
  selfValidation?: { ok?: boolean; mutationKillRate?: number; reproducibility?: number; timeTravelOk?: boolean; fuzzSecurityBreaches?: number };
  invariants?: { total?: number; passed?: number; failed?: number; skipped?: number };
  transitionCoverage?: number; businessObjectCoverage?: number; backupRestoreOk?: boolean | null;
};
type DifferentialJson = { regressions?: number; improvements?: number; baselineCommit?: string | null; diffs?: { metric: string; before: number | null; after: number | null; classification: string; note: string }[] };
const pct = (v?: number) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");

const fmt = (d: Date) => new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function TestCenterPage() {
  const admin = await requireModule("ADMIN", "UPDATE");
  if (admin.role !== "SUPER_ADMIN") redirect("/admin");

  const { runs, interrupted, last, lastFindings } = await getTestCenterDashboard();

  return (
    <div className="space-y-5">
      <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(admin, t.module, "VIEW") }))} />

      <div>
        <h1 className="text-lg font-semibold">Adventum Autonomous Test Center</h1>
        <p className="text-sm text-muted-foreground">
          Certification autonome de la plateforme. Aucune donnée préexistante n'est touchée : un run ne supprime que les
          ressources de son propre manifeste, puis vérifie leur disparition. <span className="text-foreground/70">Phase 1 — fondation de sûreté.</span>
        </p>
      </div>

      {interrupted.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base text-destructive"><Icon name="TriangleAlert" className="h-4 w-4" /> Runs à nettoyer ({interrupted.length})</CardTitle>
            <CardDescription>Des runs interrompus ou au nettoyage incomplet ont été détectés. Reprenez leur nettoyage (jamais automatique).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {interrupted.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
                <span><span className="font-mono text-xs">{r.id.slice(0, 8)}</span> · {r.mode} · {STATUS[r.status].label} · nettoyage {CLEANUP[r.cleanupStatus]} · {fmt(r.startedAt)}</span>
                <ResumeCleanupButton runId={r.id} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
        <LaunchPanel environment={resolveEnvironment()} />

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Dernier run</CardTitle></CardHeader>
          <CardContent>
            {!last ? (
              <p className="text-sm text-muted-foreground">Aucun run pour l'instant — lancez le premier.</p>
            ) : (
              (() => {
                const sum = (last.summary ?? {}) as Summary;
                const sv = sum.selfValidation ?? {};
                return (
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {last.certification && (
                    <Badge tone={CERT[last.certification].tone} dot={false} className="gap-1">
                      <Icon name={CERT[last.certification].icon} className="h-3.5 w-3.5" /> {CERT[last.certification].label}
                    </Badge>
                  )}
                  <Badge tone={STATUS[last.status].tone} dot={false}>{STATUS[last.status].label}</Badge>
                  <span className="text-muted-foreground">{last.mode} · {last.environment} · {fmt(last.startedAt)}</span>
                </div>
                {last.certification && sum.certificationReasons && sum.certificationReasons.length > 0 && (
                  <p className="text-xs text-muted-foreground">{sum.certificationReasons.join(" ")}</p>
                )}
                <div className="grid grid-cols-1 gap-x-4 gap-y-1 min-[400px]:grid-cols-2 sm:grid-cols-3">
                  <Kv k="Score santé" v={last.score != null ? `${last.score}/100` : "—"} />
                  <Kv k="Constats" v={String(last.findingsCount)} />
                  <Kv k="Critiques" v={String(last.criticalCount)} />
                  <Kv k="Invariants" v={sum.invariants ? `${sum.invariants.passed ?? 0}/${sum.invariants.total ?? 0}` : "—"} />
                  <Kv k="Couv. transitions" v={pct(sum.transitionCoverage)} />
                  <Kv k="Couv. objets" v={pct(sum.businessObjectCoverage)} />
                  <Kv k="Mutations tuées" v={pct(sv.mutationKillRate)} />
                  <Kv k="Reproductibilité" v={pct(sv.reproducibility)} />
                  <Kv k="Auto-validation" v={sv.ok == null ? "—" : sv.ok ? "OK ✓" : "échec ⚠"} />
                  <Kv k="Créées/Suppr." v={`${last.resourcesCreated}/${last.resourcesDeleted}`} />
                  <Kv k="Sauv./restaur." v={sum.backupRestoreOk == null ? "—" : sum.backupRestoreOk ? "OK ✓" : "⚠"} />
                  <Kv k="Nettoyage" v={CLEANUP[last.cleanupStatus]} />
                </div>
                {last.evidenceHash && (
                  <p className="text-[0.6875rem] text-muted-foreground">Preuve scellée (sha256) : <span className="font-mono">{last.evidenceHash.slice(0, 24)}…</span></p>
                )}
              </div>
                );
              })()
            )}
          </CardContent>
        </Card>
      </div>

      {last && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Constats du dernier run ({lastFindings.length})</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {lastFindings.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-emerald-600"><Icon name="CheckCircle2" className="h-4 w-4" /> Aucun constat.</p>
            ) : lastFindings.map((f) => (
              <div key={f.id} className="flex items-start gap-2.5 rounded-lg border border-border p-2.5">
                <Icon name={SEV[f.severity].icon} className={cn("mt-0.5 h-4 w-4 shrink-0", SEV[f.severity].cls)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{f.title}</span>
                    <Badge tone="neutral" dot={false} className="text-[0.6875rem]">{f.category}</Badge>
                    {f.module && <Badge tone="neutral" dot={false} className="text-[0.6875rem]">{f.module}</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{f.detail}</p>
                  {f.suggestion && <p className="mt-1 text-xs text-foreground/80"><span className="font-medium">Piste :</span> {f.suggestion}</p>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {last?.differential != null && (() => {
        const d = last.differential as DifferentialJson;
        if (!d.diffs || d.diffs.length === 0) return null;
        const cls: Record<string, { tone: "neutral" | "success" | "warning" | "danger"; label: string }> = {
          improvement: { tone: "success", label: "amélioration" }, regression: { tone: "danger", label: "régression" },
          expected: { tone: "neutral", label: "stable" }, ambiguous: { tone: "warning", label: "ambigu" },
        };
        return (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Différentiel vs run précédent</CardTitle>
              <CardDescription>{d.improvements ?? 0} amélioration(s) · {d.regressions ?? 0} régression(s){d.baselineCommit ? ` · base ${d.baselineCommit.slice(0, 7)}` : ""}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {d.diffs.filter((x) => x.classification !== "expected").map((x) => (
                <div key={x.metric} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 text-muted-foreground">{x.metric}</span>
                  <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{x.note}</span><Badge tone={cls[x.classification]?.tone ?? "neutral"} dot={false}>{cls[x.classification]?.label ?? x.classification}</Badge></span>
                </div>
              ))}
              {d.diffs.every((x) => x.classification === "expected") && <p className="text-sm text-muted-foreground">Aucun changement par rapport au run précédent.</p>}
            </CardContent>
          </Card>
        );
      })()}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Historique ({runs.length})</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead><TableHead>Mode</TableHead><TableHead>Certification</TableHead><TableHead>Statut</TableHead><TableHead>Score</TableHead>
                <TableHead>Créées/Suppr.</TableHead><TableHead>Nettoyage</TableHead><TableHead>Début</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="py-1.5 font-mono text-xs">{r.id.slice(0, 8)}</TableCell>
                  <TableCell className="py-1.5">{r.mode}</TableCell>
                  <TableCell className="py-1.5">{r.certification ? <Badge tone={CERT[r.certification].tone} dot={false}>{CERT[r.certification].label}</Badge> : "—"}</TableCell>
                  <TableCell className="py-1.5"><Badge tone={STATUS[r.status].tone} dot={false}>{STATUS[r.status].label}</Badge></TableCell>
                  <TableCell className="py-1.5 tabular-nums">{r.score ?? "—"}</TableCell>
                  <TableCell className="py-1.5 tabular-nums">{r.resourcesCreated}/{r.resourcesDeleted}</TableCell>
                  <TableCell className="py-1.5">{CLEANUP[r.cleanupStatus]}</TableCell>
                  <TableCell className="py-1.5 text-muted-foreground">{fmt(r.startedAt)}</TableCell>
                </TableRow>
              ))}
              {runs.length === 0 && <TableRow><TableCell colSpan={8} data-sans-etiquette className="py-3 text-center text-muted-foreground">Aucun run.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{k}</span><span className="font-semibold tabular-nums">{v}</span></div>;
}
