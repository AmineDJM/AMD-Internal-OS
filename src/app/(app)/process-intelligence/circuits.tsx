"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn } from "@/lib/utils";
import { reglerDelaiEtape } from "@/lib/actions/process-intelligence-actions";
import { formatJours, lenteur, type CircuitStats, type StepStat } from "@/lib/process/mining";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);
const TON_POINT: Record<string, string> = { ko: "bg-destructive", w: "bg-warning", i: "bg-primary" };
const TON_BARRE: Record<string, string> = { lent: "bg-destructive/80", moyen: "bg-warning/80", normal: "bg-primary/60" };

/** « Les circuits » — une ligne par circuit ; un clic ouvre son détail sous le tableau. */
export function Circuits({ circuits, stuckDays }: { circuits: CircuitStats[]; stuckDays: number }) {
  const [choix, setChoix] = React.useState<string | null>(circuits[0]?.circuit ?? null);
  const c = circuits.find((x) => x.circuit === choix) ?? null;
  if (circuits.length === 0) return <p className="surface rounded-xl px-4 py-8 text-center text-sm text-muted-foreground">Aucun dossier sur la période.</p>;
  return (
    <div className="space-y-4">
      <section className="surface overflow-hidden rounded-xl">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Les circuits</h2>
          <InfoBulle>Temps lu dans le journal de chaque circuit, du dépôt à la clôture. Un dossier est « bloqué » au-delà du délai fixé pour son étape, ou de {stuckDays} j sans délai fixé.</InfoBulle>
        </header>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-muted/90">Circuit</TableHead>
              <TableHead className="text-right">Dossiers</TableHead>
              <TableHead className="text-right">Durée médiane</TableHead>
              <TableHead className="text-right">9 sur 10 en moins de</TableHead>
              <TableHead>Étape la plus lente</TableHead>
              <TableHead className="text-right">Renvoyés</TableHead>
              <TableHead className="text-right">En cours bloqués</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {circuits.map((x) => (
              <TableRow key={x.circuit} className={cn("cursor-pointer", choix === x.circuit && "bg-secondary/60")} onClick={() => setChoix(x.circuit)} aria-selected={choix === x.circuit}>
                <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-card font-medium">{x.label}</TableCell>
                <TableCell className="text-right tabular-nums">{x.cases}</TableCell>
                <TableCell className="text-right tabular-nums">{formatJours(x.medianDays)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatJours(x.p90Days)}</TableCell>
                <TableCell className="whitespace-nowrap">{x.slowest ? <>{x.slowest.label} <span className="text-muted-foreground">· {formatJours(x.slowest.medianDays)}</span></> : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(x.returnRate)}</TableCell>
                <TableCell className={cn("text-right font-medium tabular-nums", x.stuck.length >= 5 ? "text-destructive" : x.stuck.length > 0 ? "text-warning" : "text-muted-foreground")}>{x.stuck.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      {c && <Detail c={c} />}
    </div>
  );
}

function Detail({ c }: { c: CircuitStats }) {
  const etapes = c.steps.filter((s) => s.passages > 0 || s.slaDays !== null || c.stuck.some((x) => x.step === s.step));
  const max = Math.max(0, ...etapes.map((s) => s.medianDays));
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="surface overflow-hidden rounded-xl">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{c.label} · temps par étape</h2>
          <span className="text-xs text-muted-foreground">médiane</span>
        </header>
        <ul className="divide-y divide-border">
          {etapes.map((s) => <LigneEtape key={s.step} circuit={c.circuit} s={s} max={max} />)}
          {etapes.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">Aucune étape franchie sur la période.</li>}
        </ul>
      </section>
      <div className="space-y-4">
        <section className="surface overflow-hidden rounded-xl">
          <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Ce que ça dit</h2></header>
          <ul className="divide-y divide-border">
            {c.insights.map((i, k) => (
              <li key={k} className="flex items-start gap-2.5 px-4 py-3">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", TON_POINT[i.tone])} />
                <div className="min-w-0"><p className="text-sm font-medium">{i.title}</p><p className="text-xs text-muted-foreground">{i.detail}</p></div>
              </li>
            ))}
            {c.insights.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">Rien de notable sur la période.</li>}
          </ul>
        </section>
        <section className="surface overflow-hidden rounded-xl">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">En cours bloqués</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{c.stuck.length}</span>
          </header>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {c.stuck.map((x) => {
              const corps = (
                <>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{x.label}</p>
                    <p className="text-xs text-muted-foreground">{x.stepLabel}{x.sla ? ` · délai ${x.limitDays} j` : ""}</p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-warning">{formatJours(x.days)}</span>
                </>
              );
              return (
                <li key={x.id}>
                  {x.href ? <Link href={x.href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-secondary/40">{corps}</Link> : <div className="flex items-center justify-between gap-3 px-4 py-2.5">{corps}</div>}
                </li>
              );
            })}
            {c.stuck.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">Aucun dossier bloqué.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

function LigneEtape({ circuit, s, max }: { circuit: string; s: StepStat; max: number }) {
  const [edition, setEdition] = React.useState(false);
  const [envoi, setEnvoi] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const { enCours, rafraichir } = useRafraichir();
  const ton = lenteur(s.medianDays, max, s.slaDays);
  return (
    <li className="px-4 py-2.5">
      <div className="grid grid-cols-[minmax(7rem,11rem)_1fr_auto] items-center gap-3">
        <span className="truncate text-sm" title={s.label}>{s.label}</span>
        <div className="h-2.5 overflow-hidden rounded-full bg-secondary">
          <div className={cn("h-full rounded-full", TON_BARRE[ton])} style={{ width: `${max > 0 ? Math.max(2, (s.medianDays / max) * 100) : 0}%` }} />
        </div>
        <span className="flex items-center gap-2">
          <span className="w-12 text-right text-sm tabular-nums">{s.passages > 0 ? formatJours(s.medianDays) : "—"}</span>
          <button type="button" onClick={() => setEdition((v) => !v)} className="whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-primary hover:bg-secondary">
            {s.slaDays !== null ? `délai ${s.slaDays} j` : "Régler"}
          </button>
        </span>
      </div>
      {edition && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2 text-sm"
          action={async (fd) => {
            setEnvoi(true); setErr(null);
            try {
              const r = await reglerDelaiEtape(fd);
              if (r.ok) { setEdition(false); rafraichir(); } else setErr(r.error ?? "Le délai de l'étape n'a pas été réglé.");
            } catch {
              setErr(actionFailureMessage("THROWN"));
            } finally {
              setEnvoi(false);
            }
          }}
        >
          <input type="hidden" name="circuit" value={circuit} />
          <input type="hidden" name="stepKey" value={s.step} />
          <input type="hidden" name="stepLabel" value={s.label} />
          <label className="flex items-center gap-1.5">Délai cible
            <input name="targetDays" type="number" inputMode="numeric" min={1} max={365} defaultValue={s.slaDays ?? ""} className="h-9 w-20 rounded-lg border border-input bg-background px-2 text-base sm:h-8 sm:text-sm" />
            j
          </label>
          <Button type="submit" size="sm" disabled={envoi || enCours}>{envoi && <Loader2 className="h-4 w-4 animate-spin" />}Enregistrer</Button>
          <span className="text-xs text-muted-foreground">vide = aucun délai</span>
          {err && <span className="text-xs text-destructive">{err}</span>}
        </form>
      )}
    </li>
  );
}
