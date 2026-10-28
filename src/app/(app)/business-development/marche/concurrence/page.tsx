import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { classList, labList, getClassCompetition, getLabPortfolio } from "@/lib/market/competition";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompact } from "@/lib/utils";
import { SelectNav } from "../select-nav";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

const fmtDzd = (v: number) => `${formatCompact(v)} DZD`;
const fmtPct = (g: number | null) => (g == null ? "—" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)} %`);
const pctTone = (g: number | null) => (g == null ? "text-muted-foreground" : g > 0 ? "text-success" : g < 0 ? "text-destructive" : "");

const MODES = [{ key: "class", label: "Par classe thérapeutique" }, { key: "lab", label: "Par laboratoire" }] as const;
type Mode = (typeof MODES)[number]["key"];

export default async function MarketCompetitionPage(
  props: { searchParams: Promise<{ mode?: string; class?: string; lab?: string }> }
) {
  const searchParams = await props.searchParams;
  await requireModule("BUSINESS_DEVELOPMENT");
  const mode = (MODES.some((m) => m.key === searchParams.mode) ? searchParams.mode : "class") as Mode;

  const classes = mode === "class" ? classList() : [];
  const labs = mode === "lab" ? labList() : [];
  const pickedClass = mode === "class" ? (searchParams.class && classes.includes(searchParams.class) ? searchParams.class : classes[0]) : "";
  const pickedLab = mode === "lab" ? (searchParams.lab && labs.includes(searchParams.lab) ? searchParams.lab : labs[0]) : "";

  const cc = mode === "class" && pickedClass ? getClassCompetition(pickedClass) : null;
  const lp = mode === "lab" && pickedLab ? getLabPortfolio(pickedLab) : null;

  return (
    <div className="space-y-5">
      <BackLink href="/business-development/marche">
        <ArrowLeft className="h-4 w-4" /> Intelligence marché
      </BackLink>
      <PageHeader title="Analyse produit & concurrence" description="Paysage concurrentiel : à l'intérieur d'une classe thérapeutique (acteurs, parts, croissance, concentration) ou pour un laboratoire (portefeuille par classe et par produit)." />

      <div className="flex flex-wrap items-center gap-2">
        {MODES.map((m) => (
          <Link key={m.key} href={`?mode=${m.key}`} className={`inline-flex min-h-9 items-center rounded-full px-3 py-1 text-xs font-medium sm:min-h-0 ${mode === m.key ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>{m.label}</Link>
        ))}
      </div>

      {mode === "class" && (
        <>
          <SelectNav param="class" value={pickedClass} options={classes.map((c) => ({ value: c, label: c }))} extra={{ mode: "class" }} />
          {!cc ? <p className="text-sm text-muted-foreground">Aucune donnée pour cette classe.</p> : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
                <KpiCard label="Valeur classe" value={fmtDzd(cc.summary.valueDzd)} icon="Landmark" tone="info" />
                <KpiCard label="Croissance N-1" value={fmtPct(cc.summary.growth)} icon={cc.summary.growth != null && cc.summary.growth < 0 ? "TrendingDown" : "TrendingUp"} tone={cc.summary.growth != null && cc.summary.growth >= 0 ? "success" : "danger"} />
                <KpiCard label="Concurrents" value={cc.summary.nLabs} icon="Building2" />
                <KpiCard label="Produits" value={cc.summary.nProducts} icon="Package" />
                <KpiCard label="Concentration (HHI)" value={cc.summary.hhi != null ? Math.round(cc.summary.hhi).toString() : "—"} icon="PieChart" tone={cc.summary.hhi != null && cc.summary.hhi >= 2500 ? "warning" : "default"} />
                <KpiCard label="Leader" value={cc.summary.leader} icon="Crown" tone="info" />
              </div>
              <p className="text-xs text-muted-foreground">Concentration : <strong>{cc.summary.hhiLabel}</strong> · part du leader <strong>{cc.summary.leaderShare != null ? `${(cc.summary.leaderShare * 100).toFixed(1)} %` : "—"}</strong>.</p>

              <Card>
                <CardContent className="overflow-x-auto p-0 sm:p-2">
                  <Table>
                    <TableHeader><TableRow><TableHead className="text-right">#</TableHead><TableHead>Laboratoire</TableHead><TableHead className="text-right">Valeur</TableHead><TableHead className="text-right">Part</TableHead><TableHead className="text-right">Croissance</TableHead><TableHead className="text-right">Produits</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {cc.labs.map((l, i) => (
                        <TableRow key={l.lab}>
                          <TableCell className="text-right text-muted-foreground">{i + 1}</TableCell>
                          <TableCell className="font-medium">{l.lab}{i === 0 && <Badge tone="purple" dot={false} className="ml-2">Leader</Badge>}</TableCell>
                          <TableCell className="text-right">{fmtDzd(l.valueDzd)}</TableCell>
                          <TableCell className="text-right">{(l.share * 100).toFixed(1)} %</TableCell>
                          <TableCell className={`text-right font-medium ${pctTone(l.growth)}`}>{fmtPct(l.growth)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{l.products}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="overflow-x-auto p-0 sm:p-2">
                  <Table>
                    <TableHeader><TableRow><TableHead>Produit</TableHead><TableHead>Laboratoire</TableHead><TableHead className="text-right">Valeur</TableHead><TableHead className="text-right">Part</TableHead><TableHead className="text-right">Croissance</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {cc.products.slice(0, 60).map((p) => (
                        <TableRow key={`${p.brand}-${p.lab}`}>
                          <TableCell data-sans-etiquette className="font-medium">{p.brand}</TableCell>
                          <TableCell className="text-muted-foreground">{p.lab}</TableCell>
                          <TableCell className="text-right">{fmtDzd(p.valueDzd)}</TableCell>
                          <TableCell className="text-right">{(p.share * 100).toFixed(1)} %</TableCell>
                          <TableCell className={`text-right font-medium ${pctTone(p.growth)}`}>{fmtPct(p.growth)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}

      {mode === "lab" && (
        <>
          <SelectNav param="lab" value={pickedLab} options={labs.map((l) => ({ value: l, label: l }))} extra={{ mode: "lab" }} />
          {!lp ? <p className="text-sm text-muted-foreground">Aucune donnée pour ce laboratoire.</p> : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiCard label="Valeur portefeuille" value={fmtDzd(lp.summary.valueDzd)} icon="Landmark" tone="info" />
                <KpiCard label="Croissance N-1" value={fmtPct(lp.summary.growth)} icon={lp.summary.growth != null && lp.summary.growth < 0 ? "TrendingDown" : "TrendingUp"} tone={lp.summary.growth != null && lp.summary.growth >= 0 ? "success" : "danger"} />
                <KpiCard label="Classes couvertes" value={lp.summary.nClasses} icon="LayoutGrid" />
                <KpiCard label="Produits" value={lp.summary.nProducts} icon="Package" />
              </div>

              <Card>
                <CardContent className="overflow-x-auto p-0 sm:p-2">
                  <Table>
                    <TableHeader><TableRow><TableHead>Classe (ATC4)</TableHead><TableHead className="text-right">Valeur</TableHead><TableHead className="text-right">Croissance</TableHead><TableHead className="text-right">Produits</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {lp.byClass.map((c) => (
                        <TableRow key={c.cls}>
                          <TableCell data-sans-etiquette className="font-medium [overflow-wrap:anywhere]">{c.cls}</TableCell>
                          <TableCell className="text-right">{fmtDzd(c.valueDzd)}</TableCell>
                          <TableCell className={`text-right font-medium ${pctTone(c.growth)}`}>{fmtPct(c.growth)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{c.products}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="overflow-x-auto p-0 sm:p-2">
                  <Table>
                    <TableHeader><TableRow><TableHead>Produit</TableHead><TableHead>Présentation</TableHead><TableHead>Classe</TableHead><TableHead className="text-right">Valeur</TableHead><TableHead className="text-right">Croissance</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {lp.products.slice(0, 80).map((p, i) => (
                        <TableRow key={`${p.brand}-${i}`}>
                          <TableCell data-sans-etiquette className="font-medium">{p.brand}</TableCell>
                          <TableCell className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.presentation}</TableCell>
                          <TableCell className="text-muted-foreground">{p.cls}</TableCell>
                          <TableCell className="text-right">{fmtDzd(p.valueDzd)}</TableCell>
                          <TableCell className={`text-right font-medium ${pctTone(p.growth)}`}>{fmtPct(p.growth)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
