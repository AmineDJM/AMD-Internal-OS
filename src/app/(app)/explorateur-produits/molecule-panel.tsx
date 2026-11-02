"use client";

import * as React from "react";
import { Loader2, Building2, Factory, Ship, Trophy, AlertTriangle } from "lucide-react";
import { analyzeMarketMolecule } from "@/lib/actions/market-actions";
import type { MoleculeAnalysis } from "@/lib/market/molecule";
import { FORM_LABEL } from "@/lib/market/galenic";
import { Badge } from "@/components/ui/badge";
import { Table } from "@/components/ui/table";
import { Donut } from "@/components/charts/donut";
import { foldTail, seriesColor, SERIES } from "@/components/charts/palette";
import { formatCompact, formatNumber } from "@/lib/utils";

const fmtDzd = (v: number) => `${formatCompact(v)} DZD`;

/**
 * ANALYSE CONCURRENTIELLE D'UNE MOLÉCULE — la réponse à « qui est déjà là, et pour combien ? ».
 *
 * Trois choses, dans cet ordre, parce que c'est l'ordre des questions qu'on se pose :
 *   1. **combien pèse ce marché**, et comment il se partage entre la ville et l'hôpital ;
 *   2. **qui le détient** — part de marché de chaque laboratoire, concentration ;
 *   3. **qui a le droit d'y entrer** — enregistrements à la nomenclature, fabriqués
 *      localement ou importés.
 *
 * Tout vient des données réelles (IQVIA ville, réceptions PCH hôpital, Nomenclature DZ) :
 * rien n'est estimé ni simulé.
 */
export function MoleculePanel({ molecule, dosage, form }: { molecule: string; dosage: string; form: string }) {
  const [data, setData] = React.useState<MoleculeAnalysis | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const seq = React.useRef(0);

  React.useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      let r: Awaited<ReturnType<typeof analyzeMarketMolecule>>;
      try {
        r = await analyzeMarketMolecule({ molecule, dosage, form });
      } catch {
        if (mine !== seq.current) return;
        setLoading(false); setData(null);
        setErr("L'analyse du marché n'a pas pu être chargée (connexion ou serveur).");
        return;
      }
      if (mine !== seq.current) return;
      setLoading(false);
      if (!r.ok) { setErr(r.error ?? "Analyse impossible."); setData(null); return; }
      setErr(null);
      setData(r.analysis);
    }, 350);
    return () => clearTimeout(t);
  }, [molecule, dosage, form]);

  if (loading && !data) {
    return (
      <p className="surface flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Analyse du marché de « {molecule} »…
      </p>
    );
  }
  if (err) {
    return (
      <p className="surface flex items-start gap-2 p-4 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {err}
      </p>
    );
  }
  if (!data) return null;

  // Parts de marché : au plus 6 tranches, la queue repliée dans « Autres ».
  const shareSlices = foldTail(data.competitors.map((c) => ({ label: c.lab, value: c.valueDzd })));
  const segmentSlices = [
    { label: "Ville (officine)", value: data.ville.valueDzd, color: SERIES[0] },
    { label: "Hôpital (PCH)", value: data.hopital.valueDzd, color: SERIES[2] },
  ].filter((s) => s.value > 0);

  const concentration = data.hhi >= 2500 ? "Marché concentré" : data.hhi >= 1500 ? "Concentration modérée" : "Marché fragmenté";
  const concentrationTone = data.hhi >= 2500 ? "warning" : data.hhi >= 1500 ? "info" : "success";

  return (
    <section className="space-y-4 rounded-xl border border-primary/30 bg-primary/[0.03] p-3 sm:p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{data.molecule}</h2>
        {data.dosage && <Badge tone="neutral" dot={false}>{data.dosage}</Badge>}
        {data.form && <Badge tone="neutral" dot={false}>{FORM_LABEL[data.form]}</Badge>}
        <span className="text-xs text-muted-foreground">
          {data.matched.ville} réf. ville · {data.matched.hopital} lignes hôpital · {data.matched.nomenclature} enregistrements
        </span>
      </header>

      {/* 1. Combien pèse ce marché */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Marché total" value={fmtDzd(data.total.valueDzd)} hint={`$${formatCompact(data.total.valueUsd)}`} />
        <Stat label="Volume" value={formatNumber(Math.round(data.total.volume))} hint="unités" />
        <Stat label="Acteurs présents" value={String(data.total.players)} hint={`top 3 : ${data.top3Share.toFixed(0)} %`} />
        <Stat label="Concentration" value={concentration} hint={`HHI ${data.hhi}`} tone={concentrationTone} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 2. Où est le marché : ville ou hôpital */}
        <div className="surface space-y-3 p-4">
          <h3 className="text-sm font-semibold">Marché adressable : ville ou hôpital</h3>
          {segmentSlices.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Aucune vente enregistrée sur les deux marchés.</p>
          ) : (
            <>
              <Donut
                slices={segmentSlices}
                total={data.total.valueDzd}
                centerLabel="marché total"
                centerValue={fmtDzd(data.total.valueDzd)}
                format={fmtDzd}
                size={148}
              />
              <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Ville — {data.ville.pct.toFixed(1)} %</dt>
                  <dd className="tabular-nums">{formatNumber(Math.round(data.ville.volume))} unités · {data.ville.players} acteurs</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Hôpital — {data.hopital.pct.toFixed(1)} %</dt>
                  <dd className="tabular-nums">{formatNumber(Math.round(data.hopital.volume))} unités · {data.hopital.players} acteurs</dd>
                </div>
              </dl>
            </>
          )}
        </div>

        {/* 3. Qui détient ce marché */}
        <div className="surface space-y-3 p-4">
          <h3 className="text-sm font-semibold">Parts de marché</h3>
          {shareSlices.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Aucune part de marché mesurable.</p>
          ) : (
            <Donut
              slices={shareSlices}
              total={data.total.valueDzd}
              centerLabel="acteurs"
              centerValue={String(data.total.players)}
              format={fmtDzd}
              size={148}
            />
          )}
        </div>
      </div>

      {/* Le détail acteur par acteur — la couleur reprend celle du camembert. */}
      {data.competitors.length > 0 && (
        <div className="surface overflow-hidden">
          <div className="border-b border-border px-4 py-2.5">
            <h3 className="text-sm font-semibold">Environnement concurrentiel</h3>
          </div>
          {/* Au téléphone, un laboratoire = une carte : sept colonnes ne tiennent pas dans 360 px. */}
          <div className="p-2 sm:p-0">
            <Table>
              <thead className="bg-secondary/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Laboratoire</th>
                  <th className="px-3 py-2 text-right font-medium">Part</th>
                  <th className="px-3 py-2 text-right font-medium">Valeur</th>
                  <th className="px-3 py-2 text-right font-medium">Ville</th>
                  <th className="px-3 py-2 text-right font-medium">Hôpital</th>
                  <th className="px-3 py-2 text-left font-medium">Origine</th>
                  <th className="px-3 py-2 text-left font-medium">Marques</th>
                </tr>
              </thead>
              <tbody className="sm:divide-y sm:divide-border">
                {data.competitors.slice(0, 25).map((c, i) => (
                  <tr key={c.lab}>
                    <td data-sans-etiquette className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: seriesColor(i) }} aria-hidden />
                        <span className="font-medium">{c.lab}</span>
                        {i === 0 && <Trophy className="h-3.5 w-3.5 text-warning" aria-label="Leader" />}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{c.share.toFixed(1)} %</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDzd(c.valueDzd)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{c.villeDzd > 0 ? fmtDzd(c.villeDzd) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{c.hopitalDzd > 0 ? fmtDzd(c.hopitalDzd) : "—"}</td>
                    <td className="px-3 py-2"><OriginBadge origin={c.origin} registrations={c.registrations} /></td>
                    <td className="px-3 py-2 text-muted-foreground sm:max-w-[16rem] sm:truncate" title={c.brands.join(", ")}>
                      {c.brands.join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {data.competitors.length > 25 && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              + {data.competitors.length - 25} autre(s) acteur(s) de plus petite taille.
            </p>
          )}
        </div>
      )}

      {/* Aide à affiner : les dosages et formes réellement présents sur cette molécule. */}
      {(data.dosagesFound.length > 0 || data.formsFound.length > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.formsFound.length > 0 && (
            <FoundList title="Formes présentes sur ce marché" items={data.formsFound.map((f) => ({ label: FORM_LABEL[f.value], value: f.valueDzd }))} total={data.total.valueDzd} />
          )}
          {data.dosagesFound.length > 0 && (
            <FoundList title="Dosages présents sur ce marché" items={data.dosagesFound.map((d) => ({ label: d.value, value: d.valueDzd }))} total={data.total.valueDzd} />
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  const toneCls = tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : tone === "info" ? "text-primary" : "";
  return (
    <div className="surface p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-base font-semibold ${toneCls}`}>{value}</p>
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Fabriqué en Algérie ou importé — l'information vient de la nomenclature (enregistrements). */
function OriginBadge({ origin, registrations }: { origin: "LOCAL" | "IMPORT" | "MIXTE" | null; registrations: number }) {
  if (!origin) return <span className="text-xs text-muted-foreground">non enregistré</span>;
  const cfg = {
    LOCAL: { label: "Fabriqué local", tone: "success" as const, Icon: Factory },
    IMPORT: { label: "Importé", tone: "info" as const, Icon: Ship },
    MIXTE: { label: "Local + importé", tone: "purple" as const, Icon: Building2 },
  }[origin];
  return (
    <span className="inline-flex items-center gap-1.5">
      <cfg.Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <Badge tone={cfg.tone} dot={false}>{cfg.label}</Badge>
      <span className="text-[0.6875rem] text-muted-foreground">{registrations} enr.</span>
    </span>
  );
}

function FoundList({ title, items, total }: { title: string; items: { label: string; value: number }[]; total: number }) {
  return (
    <div className="surface p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="mt-2 space-y-1">
        {items.slice(0, 8).map((i) => (
          <li key={i.label} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{i.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {fmtDzd(i.value)} · {total > 0 ? ((i.value / total) * 100).toFixed(0) : 0} %
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
