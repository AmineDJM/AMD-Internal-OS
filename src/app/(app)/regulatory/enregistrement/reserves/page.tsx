import { notFound } from "next/navigation";
import { ArrowLeft, Library, AlertTriangle, TrendingUp, Lock } from "lucide-react";
import { requireModule } from "@/lib/session";
import { canSeeRegEnrollment } from "@/lib/org-chart-access";
import { getAppSettings } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { reserveStats } from "@/lib/regulatory/intelligence/reserves/library";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Donut } from "@/components/charts/donut";
import { foldTail } from "@/components/charts/palette";
import { formatDate } from "@/lib/utils";
import { ReserveLibraryPanel } from "./reserve-library-panel";
import { BackLink } from "@/components/shared/back-link";
import { RegScopeCard } from "../scope-gate";

export const metadata = { title: "Réserves ANPP — bibliothèque" };
export const dynamic = "force-dynamic";

/**
 * BIBLIOTHÈQUE DES RÉSERVES ANPP — la mémoire de ce que l'agence nous a déjà reproché.
 *
 * L'écran répond, dans cet ordre, aux questions qu'on se pose réellement :
 *   1. **que nous reproche-t-on le plus souvent ?** (récurrences, catégories, modules) ;
 *   2. **qui déclenche ces réserves ?** (fournisseurs, DCI) ;
 *   3. **qu'avons-nous appris ?** (règles dérivées — inertes tant qu'un humain ne valide pas).
 *
 * Réservé à `regulatory.reserve.manage`, borné à l'entité.
 */
export default async function ReserveLibraryPage() {
  const user = await requireModule("REGULATORY");
  const settings = await getAppSettings();
  if (!canSeeRegEnrollment(user, settings)) notFound();
  if (!regCan(user, "regulatory.reserve.manage") && user.role !== "SUPER_ADMIN") notFound();
  const companyId = await resolveRegCompanyIdFor(user.id);
  // Portée non résolue : dire quoi faire (choisir l'entité / activer le module) — pas de 404
  // muette sur une page qui existe.
  if (!companyId) {
    return (
      <div className="space-y-5">
        <BackLink href="/regulatory/enregistrement/analyse">
          <ArrowLeft className="h-4 w-4" /> Analyse CTD
        </BackLink>
        <PageHeader
          title="Réserves ANPP — bibliothèque"
          description="Tout ce que l'agence nous a déjà reproché, avec sa preuve."
        />
        <RegScopeCard userId={user.id} />
      </div>
    );
  }

  const [stats, batches, rules] = await Promise.all([
    reserveStats(),
    prisma.anppReserveBatch.findMany({
      where: { companyId },
      orderBy: { receivedAt: "desc" },
      take: 20,
      select: { id: true, sourceFilename: true, sourceKind: true, receivedAt: true, extractedCount: true, pageCount: true },
    }),
    prisma.anppDerivedRule.findMany({ orderBy: [{ status: "asc" }, { confidence: "desc" }], take: 40 }),
  ]);

  const categorySlices = foldTail(stats.byCategory.map((c) => ({ label: c.key, value: c.count })));
  const moduleSlices = foldTail(stats.byModule.map((c) => ({ label: c.key, value: c.count })));

  return (
    <div className="space-y-5">
      <BackLink href="/regulatory/enregistrement/analyse">
        <ArrowLeft className="h-4 w-4" /> Analyse CTD
      </BackLink>
      <PageHeader
        title="Réserves ANPP — bibliothèque"
        description="Tout ce que l'agence nous a déjà reproché, avec sa preuve. Sert à anticiper les réserves d'un nouveau dossier et à réutiliser les réponses qui ont fonctionné."
      />

      {/* Le rappel qui conditionne tout l'usage de cet écran. */}
      <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          Une réserve historique est un <strong>précédent</strong>, jamais une règle juridique générale.
          Rien ici ne s&apos;applique automatiquement à un dossier : les règles dérivées restent
          <strong> sans effet</strong> tant qu&apos;un membre du Regulatory ne les a pas validées.
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Réserves enregistrées" value={String(stats.total)} />
        <Stat label="Ouvertes" value={String(stats.open)} tone={stats.open > 0 ? "warning" : undefined} />
        <Stat label="Acceptées par l'ANPP" value={String(stats.accepted)} tone="success" hint="réponses qui ont fonctionné" />
        <Stat label="Réitérées" value={String(stats.reiterated)} tone={stats.reiterated > 0 ? "danger" : undefined} hint="la réponse n'avait pas suffi" />
      </div>

      {/* Import + recherche de précédents. */}
      <ReserveLibraryPanel />

      {stats.total > 0 && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="surface space-y-3 p-4">
              <h2 className="text-sm font-semibold">Ce qu&apos;on nous reproche</h2>
              {categorySlices.length === 0
                ? <p className="py-4 text-sm text-muted-foreground">Pas encore de répartition.</p>
                : <Donut slices={categorySlices} total={stats.total} centerLabel="réserves" centerValue={String(stats.total)} format={(n) => `${n}`} size={148} />}
            </section>
            <section className="surface space-y-3 p-4">
              <h2 className="text-sm font-semibold">Où, dans le CTD</h2>
              {moduleSlices.length === 0
                ? <p className="py-4 text-sm text-muted-foreground">Pas encore de répartition.</p>
                : <Donut slices={moduleSlices} total={stats.total} centerLabel="réserves" centerValue={String(stats.total)} format={(n) => `${n}`} size={148} />}
            </section>
          </div>

          {stats.recurring.length > 0 && (
            <section className="surface space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <TrendingUp className="h-4 w-4 text-warning" />
                <h2 className="text-sm font-semibold">Réserves récurrentes</h2>
                <span className="text-xs text-muted-foreground">le même reproche, plusieurs fois</span>
              </div>
              <ul className="divide-y divide-border">
                {stats.recurring.slice(0, 10).map((r, i) => (
                  <li key={i} className="flex flex-wrap items-start gap-3 py-2.5 text-sm">
                    <Badge tone="warning" dot={false}>{r.count}×</Badge>
                    <span className="min-w-0 flex-1">{r.verbatim.slice(0, 220)}{r.verbatim.length > 220 ? "…" : ""}</span>
                    {r.reiterated > 0 && <Badge tone="danger" dot={false}>{r.reiterated} réitérée(s)</Badge>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <StatTable title="Par fournisseur" rows={stats.bySupplier.slice(0, 10)} />
            <StatTable title="Par DCI" rows={stats.byDci.slice(0, 10)} />
          </div>
        </>
      )}

      {/* Règles dérivées — la frontière entre apprendre et décider. */}
      <section className="surface space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Library className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Règles dérivées</h2>
          <Badge tone="neutral" dot={false}>{rules.filter((r) => r.status === "VALIDATED").length} active(s)</Badge>
          <Badge tone="warning" dot={false}>{rules.filter((r) => r.status === "PROPOSED").length} en attente</Badge>
        </div>
        {rules.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Aucune règle proposée pour le moment. Elles apparaissent quand un même reproche revient au moins trois fois.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rules.map((r) => (
              <li key={r.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.status === "VALIDATED" ? "success" : r.status === "REJECTED" ? "neutral" : "warning"} dot={false}>
                    {r.status === "VALIDATED" ? "Active" : r.status === "REJECTED" ? "Écartée" : "À valider"}
                  </Badge>
                  <span className="font-medium">{r.title}</span>
                  <span className="text-xs text-muted-foreground">
                    confiance {Math.round(r.confidence * 100)} % · {r.occurrences} occurrence(s)
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{r.statement}</p>
                {r.status === "PROPOSED" && (
                  <p className="flex items-center gap-1.5 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" /> Sans effet tant qu&apos;elle n&apos;est pas validée.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Traçabilité des imports. */}
      {batches.length > 0 && (
        <section className="surface space-y-2 p-4">
          <h2 className="text-sm font-semibold">Lettres importées</h2>
          <ul className="divide-y divide-border">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{b.sourceFilename}</span>
                <Badge tone="neutral" dot={false}>{b.sourceKind}</Badge>
                <span className="text-xs text-muted-foreground">
                  {b.extractedCount} réserve(s){b.pageCount > 0 ? ` · ${b.pageCount} page(s)` : ""} · {formatDate(b.receivedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warning" | "success" | "danger" }) {
  const cls = tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : tone === "danger" ? "text-destructive" : "";
  return (
    <div className="surface p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold ${cls}`}>{value}</p>
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function StatTable({ title, rows }: { title: string; rows: { key: string; count: number; reiterated: number; critical: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="mt-2 divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{r.key}</span>
            <span className="tabular-nums text-muted-foreground">{r.count}</span>
            {r.reiterated > 0 && <Badge tone="danger" dot={false}>{r.reiterated} réit.</Badge>}
            {r.critical > 0 && <Badge tone="warning" dot={false}>{r.critical} crit.</Badge>}
          </li>
        ))}
      </ul>
    </section>
  );
}
