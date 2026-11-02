import { ArrowLeft, Store, Building2 } from "lucide-react";
import { requireModule } from "@/lib/session";
import { pricingDciList, getPriceForDci, type PriceStats } from "@/lib/market/pricing";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatDate } from "@/lib/utils";
import { SelectNav } from "../select-nav";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const dzd = (v: number | null | undefined) => (v == null ? "—" : `${formatNumber(Math.round(v))} DZD`);
const fmtPct = (g: number | null) => (g == null ? "—" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)} %`);

function StatBlock({ stats }: { stats: PriceStats }) {
  return (
    <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">
      <KpiCard label="Prix moyen" value={dzd(stats.avgDzd)} icon="Tag" tone="info" />
      <KpiCard label="Médiane" value={dzd(stats.median)} icon="Gauge" />
      <KpiCard label="Minimum" value={dzd(stats.min)} icon="ArrowDownNarrowWide" tone="success" />
      <KpiCard label="Maximum" value={dzd(stats.max)} icon="ArrowUpNarrowWide" tone="warning" />
    </div>
  );
}

export default async function MarketPricingPage(props: { searchParams: Promise<{ dci?: string }> }) {
  const searchParams = await props.searchParams;
  await requireModule("BUSINESS_DEVELOPMENT");
  const list = pricingDciList();
  const picked = searchParams.dci && list.some((d) => d.key === searchParams.dci) ? searchParams.dci : list[0]?.key ?? "";
  const res = picked ? getPriceForDci(picked) : null;

  return (
    <div className="space-y-5">
      <BackLink href="/business-development/marche">
        <ArrowLeft className="h-4 w-4" /> Intelligence marché
      </BackLink>
      <PageHeader title="Intelligence prix" description="Prix par DCI : prix moyen et fourchette par boîte (IQVIA ville) et par unité (réceptions PCH hospitalières). Données réelles réconciliées." />

      <SelectNav param="dci" value={picked} options={list.map((d) => ({ value: d.key, label: d.dci }))} placeholder="Choisir une DCI…" />

      {!res ? (
        <p className="text-sm text-muted-foreground">Sélectionnez une DCI pour afficher son intelligence prix.</p>
      ) : (
        <>
          <h2 className="text-lg font-semibold">{res.dci}</h2>

          {/* Ville (IQVIA) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Store className="h-4 w-4 text-primary" /> Marché de ville — prix par boîte (IQVIA)</CardTitle>
              <CardDescription>{res.ville ? `${res.ville.n} présentations · moyenne pondérée par le volume` : "Aucune donnée IQVIA pour cette DCI."}</CardDescription>
            </CardHeader>
            {res.ville && (
              <CardContent className="space-y-3">
                <StatBlock stats={res.ville} />
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Produit</TableHead><TableHead>Présentation</TableHead><TableHead>Laboratoire</TableHead><TableHead className="text-right">Volume</TableHead><TableHead className="text-right">Prix / boîte</TableHead><TableHead className="text-right">Croissance</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {res.villeRows.slice(0, 60).map((r, i) => (
                        <TableRow key={`${r.brand}-${i}`}>
                          <TableCell data-sans-etiquette className="font-medium">{r.brand}</TableCell>
                          <TableCell className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.presentation}</TableCell>
                          <TableCell className="text-muted-foreground">{r.lab}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{formatNumber(Math.round(r.volume))}</TableCell>
                          <TableCell className="text-right font-medium">{dzd(r.priceBoxDzd)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{fmtPct(r.growth)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}
          </Card>

          {/* Hôpital (PCH) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4 text-primary" /> Marché hospitalier — prix par unité (PCH)</CardTitle>
              <CardDescription>{res.hospital ? `${res.hospital.n} réceptions · moyenne pondérée par la quantité` : "Aucune réception PCH pour cette DCI."}</CardDescription>
            </CardHeader>
            {res.hospital && (
              <CardContent className="space-y-3">
                <StatBlock stats={res.hospital} />
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Produit</TableHead><TableHead>Fournisseur</TableHead><TableHead className="text-right">Quantité</TableHead><TableHead className="text-right">Prix unitaire</TableHead><TableHead className="text-right">Valeur</TableHead><TableHead>Réception</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {res.hospitalRows.slice(0, 60).map((r, i) => (
                        <TableRow key={`${r.product}-${i}`}>
                          <TableCell data-sans-etiquette className="font-medium [overflow-wrap:anywhere]">{r.product}</TableCell>
                          <TableCell className="text-muted-foreground">{r.lab}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{formatNumber(Math.round(r.qte))}</TableCell>
                          <TableCell className="text-right font-medium">{dzd(r.unitPriceDzd)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{dzd(r.valueDzd)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.date ? formatDate(r.date) : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
