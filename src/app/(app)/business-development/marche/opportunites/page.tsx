import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getOpportunities } from "@/lib/market/engine";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompact } from "@/lib/utils";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const fmtUsd = (v: number) => `$${formatCompact(v)}`;
const fmtPct = (g: number | null) => (g == null ? "—" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(0)} %`);
const pctTone = (g: number | null) => (g == null ? "text-muted-foreground" : g > 0 ? "text-success" : g < 0 ? "text-destructive" : "");

const VIEWS = [
  { key: "eligible", label: "Éligibles" },
  { key: "import_substitution", label: "Substitution import" },
  { key: "all", label: "Toutes" },
] as const;
const MINS = [
  { v: 0, label: "Tous marchés" },
  { v: 300000, label: "≥ $300k" },
  { v: 1000000, label: "≥ $1M" },
  { v: 3000000, label: "≥ $3M" },
];

function scoreTone(s: number): "success" | "info" | "warning" | "neutral" {
  return s >= 75 ? "success" : s >= 60 ? "info" : s >= 45 ? "warning" : "neutral";
}

export default async function MarketOpportunitiesPage(props: { searchParams: Promise<{ view?: string; min?: string }> }) {
  const searchParams = await props.searchParams;
  await requireModule("BUSINESS_DEVELOPMENT");
  const view = (["eligible", "import_substitution", "all"].includes(searchParams.view ?? "") ? searchParams.view : "eligible") as "eligible" | "import_substitution" | "all";
  const minUsd = Number(searchParams.min) || 0;
  const o = getOpportunities(view, minUsd, 150);
  const qs = (next: Partial<{ view: string; min: number }>) =>
    `?view=${next.view ?? view}&min=${next.min ?? minUsd}`;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 text-sm">
        <BackLink href="/business-development/marche">
          <ArrowLeft className="h-4 w-4" /> Intelligence marché
        </BackLink>
      </div>
      <PageHeader
        title="Opportunités stratégiques"
        description="Screening automatique des DCI à fort potentiel : taille de marché (IQVIA + PCH), intensité concurrentielle locale (Nomenclature) et opportunités de substitution aux importations."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Opportunités affichées" value={o.kpis.count} icon="Target" tone="info" />
        <KpiCard label="Marché cumulé" value={fmtUsd(o.kpis.marketSumUsd)} icon="DollarSign" tone="success" />
        <KpiCard label="Substitution import" value={o.kpis.importSubstitution} icon="Replace" tone="warning" />
        <KpiCard label="Score médian" value={o.kpis.scoreMedian.toFixed(1)} icon="Gauge" />
      </div>

      {/* Filtres */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Vue :</span>
        {VIEWS.map((v) => (
          <Link key={v.key} href={qs({ view: v.key })} className={`inline-flex min-h-9 items-center rounded-full px-3 py-1 text-xs font-medium sm:min-h-0 ${view === v.key ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>{v.label}</Link>
        ))}
        <span className="w-full text-xs font-medium text-muted-foreground sm:ml-3 sm:w-auto">Marché :</span>
        {MINS.map((m) => (
          <Link key={m.v} href={qs({ min: m.v })} className={`inline-flex min-h-9 items-center rounded-full px-3 py-1 text-xs font-medium sm:min-h-0 ${minUsd === m.v ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>{m.label}</Link>
        ))}
        <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">{o.totalScored} DCI évaluées · {o.totalEligible} éligibles · {o.totalImportSub} substitution import</span>
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0 sm:p-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Score</TableHead><TableHead>DCI</TableHead>
                <TableHead className="text-right">Marché (USD)</TableHead><TableHead className="text-right">Croissance</TableHead>
                <TableHead className="text-right">Fab. locaux</TableHead><TableHead className="text-right">Import.</TableHead>
                <TableHead>Lecture</TableHead><TableHead>Sources</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.rows.length === 0 ? (
                <TableRow><TableCell colSpan={8} data-sans-etiquette className="py-8 text-center text-sm text-muted-foreground">Aucune opportunité pour ce filtre.</TableCell></TableRow>
              ) : o.rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="text-right"><Badge tone={scoreTone(r.opportunityScore)} dot={false}>{r.opportunityScore.toFixed(1)}</Badge></TableCell>
                  <TableCell className="font-medium">{r.dci}{r.topProducts && <span className="block truncate text-xs font-normal text-muted-foreground" title={r.topProducts}>{r.topProducts}</span>}</TableCell>
                  <TableCell className="text-right">{fmtUsd(r.valueUsd)}<span className="block text-xs text-muted-foreground">{r.bucket}</span></TableCell>
                  <TableCell className={`text-right ${pctTone(r.growth)}`}>{fmtPct(r.growth)}</TableCell>
                  <TableCell className="text-right">{r.manufacturers}<span className="text-xs text-muted-foreground">/{r.allowed}</span></TableCell>
                  <TableCell className="text-right text-muted-foreground">{r.importers}</TableCell>
                  <TableCell className="text-xs">{r.recommendation}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.sources}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Score 0-100 : valeur de marché (50) + faible concurrence locale (25) + demande d'import (10) + croissance (15).
        « Fab. locaux » indique le nombre de fabricants algériens enregistrés vs le seuil toléré pour la taille du marché.
      </p>
    </div>
  );
}
