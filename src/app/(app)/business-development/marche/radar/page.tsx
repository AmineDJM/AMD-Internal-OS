import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getRadarWhite, getRadarNew, getRadarExpirations } from "@/lib/market/radar";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompact, formatDate } from "@/lib/utils";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const fmtUsd = (v: number) => `$${formatCompact(v)}`;
const fmtPct = (g: number | null) => (g == null ? "—" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(0)} %`);

const TABS = [
  { key: "white", label: "White spaces" },
  { key: "new", label: "Nouvelles AMM" },
  { key: "expirations", label: "Expirations" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default async function MarketRadarPage(props: { searchParams: Promise<{ tab?: string }> }) {
  const searchParams = await props.searchParams;
  await requireModule("BUSINESS_DEVELOPMENT");
  const tab = (TABS.some((t) => t.key === searchParams.tab) ? searchParams.tab : "white") as Tab;

  const white = tab === "white" ? getRadarWhite(300_000) : null;
  const neu = tab === "new" ? getRadarNew(6, 500_000, 2) : null;
  const exp = tab === "expirations" ? getRadarExpirations(5, 24) : null;

  return (
    <div className="space-y-5">
      <BackLink href="/business-development/marche">
        <ArrowLeft className="h-4 w-4" /> Intelligence marché
      </BackLink>
      <PageHeader title="Radar du marché" description="Fenêtres d'opportunité : marchés sans fabricant local, nouvelles autorisations récentes et expirations d'enregistrements à venir." />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <Link key={t.key} href={`?tab=${t.key}`} className={`inline-flex min-h-9 items-center rounded-full px-3 py-1 text-xs font-medium sm:min-h-0 ${tab === t.key ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>{t.label}</Link>
        ))}
      </div>

      {white && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="White spaces" value={white.kpis.count} icon="Target" tone="info" />
            <KpiCard label="Marché cumulé" value={fmtUsd(white.kpis.marketSumUsd)} icon="DollarSign" tone="success" />
            <KpiCard label="Avec demande d'import" value={white.kpis.withImportDemand} icon="Replace" tone="warning" />
            <KpiCard label="Marché médian" value={fmtUsd(white.kpis.marketMedianUsd)} icon="Gauge" />
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0 sm:p-2">
              <Table>
                <TableHeader><TableRow><TableHead>DCI</TableHead><TableHead className="text-right">Marché (USD)</TableHead><TableHead className="text-right">Croissance</TableHead><TableHead className="text-right">Importateurs</TableHead><TableHead>Labos importateurs</TableHead></TableRow></TableHeader>
                <TableBody>
                  {white.rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell data-sans-etiquette className="font-medium">{r.dci}</TableCell>
                      <TableCell className="text-right">{fmtUsd(r.valueUsd)}</TableCell>
                      <TableCell className="text-right">{fmtPct(r.growth)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{r.importers}</TableCell>
                      <TableCell className="text-xs text-muted-foreground [overflow-wrap:anywhere] sm:max-w-md sm:truncate" title={r.impLabs || undefined}>{r.impLabs || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {neu && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Nouvelles AMM" value={neu.kpis.count} icon="Sparkles" tone="info" />
            <KpiCard label="Marché cumulé" value={fmtUsd(neu.kpis.marketSumUsd)} icon="DollarSign" tone="success" />
            <KpiCard label="White spaces" value={neu.kpis.whiteSpace} icon="Target" tone="warning" />
            <KpiCard label="Marché médian" value={fmtUsd(neu.kpis.marketMedianUsd)} icon="Gauge" />
          </div>
          <p className="text-xs text-muted-foreground">AMM initiales des 6 derniers mois, marché ≥ $500k, ≤ 2 concurrents (fabricants + importateurs).</p>
          <Card>
            <CardContent className="overflow-x-auto p-0 sm:p-2">
              <Table>
                <TableHeader><TableRow><TableHead>DCI</TableHead><TableHead>Dernière AMM</TableHead><TableHead className="text-right">Marché (USD)</TableHead><TableHead className="text-right">Croissance</TableHead><TableHead className="text-right">Concurrents</TableHead><TableHead>Sources</TableHead></TableRow></TableHeader>
                <TableBody>
                  {neu.rows.length === 0 ? <TableRow><TableCell colSpan={6} data-sans-etiquette className="py-8 text-center text-sm text-muted-foreground">Aucune nouvelle AMM correspondant aux critères.</TableCell></TableRow> : neu.rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell data-sans-etiquette className="font-medium">{r.dci}</TableCell>
                      <TableCell className="text-muted-foreground">{r.lastRegistration ? formatDate(r.lastRegistration) : "—"}</TableCell>
                      <TableCell className="text-right">{fmtUsd(r.valueUsd)}</TableCell>
                      <TableCell className="text-right">{fmtPct(r.growth)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{r.concurrents}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.sources}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {exp && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Échéances (24 mois)" value={exp.kpis.count} icon="CalendarClock" tone="info" />
            <KpiCard label="DCI concernées" value={exp.kpis.nDci} icon="Pill" />
            <KpiCard label="Laboratoires" value={exp.kpis.nLabs} icon="Building2" />
            <KpiCard label="Produits importés" value={exp.kpis.imported} icon="Globe" tone="warning" />
          </div>
          <p className="text-xs text-muted-foreground">Échéance estimée = dernière décision + 5 ans de validité, dans une fenêtre de −6 à +24 mois.</p>
          <Card>
            <CardContent className="overflow-x-auto p-0 sm:p-2">
              <Table>
                <TableHeader><TableRow><TableHead>Échéance</TableHead><TableHead>Produit</TableHead><TableHead>DCI</TableHead><TableHead>Laboratoire</TableHead><TableHead>Origine</TableHead><TableHead>Forme / Dosage</TableHead></TableRow></TableHeader>
                <TableBody>
                  {exp.rows.slice(0, 300).map((r, i) => (
                    <TableRow key={`${r.produit}-${i}`}>
                      <TableCell className="whitespace-nowrap font-medium">{formatDate(r.echeance)}</TableCell>
                      <TableCell>{r.produit}</TableCell>
                      <TableCell className="text-muted-foreground">{r.dci}</TableCell>
                      <TableCell className="text-muted-foreground">{r.laboratoire}</TableCell>
                      <TableCell><Badge tone={r.origine === "IMPORT" ? "warning" : r.origine === "LOCAL" ? "success" : "neutral"} dot={false}>{r.origine}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{[r.forme, r.dosage].filter((x) => x && x !== "—").join(" · ") || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
