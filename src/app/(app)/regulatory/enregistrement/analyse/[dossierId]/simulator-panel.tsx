"use client";

import * as React from "react";

import { Loader2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { runSimulationAction } from "@/lib/regulatory/intelligence/simulator/actions";
import type { SimPerspective } from "@/lib/regulatory/intelligence/simulator/run";

interface Sim { perspectives: SimPerspective[]; overall: string | null; createdAt: string }

const VERDICT: Record<string, string> = {
  FAVORABLE: "bg-success/10 text-success", RESERVES: "bg-amber-500/10 text-amber-600", DEFAVORABLE: "bg-destructive/10 text-destructive",
};

/**
 * Reviewer Simulator (G11) — stress test multi-perspectives. Affiché comme une SIMULATION
 * INTERNE NON PRÉDICTIVE (jamais une décision de l'ANPP).
 */
export function SimulatorPanel({ dossierId, last }: { dossierId: string; last: Sim | null }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Sim | null>(last);

  async function run() {
    setBusy(true); setError(null);
    const fd = new FormData(); fd.set("dossierId", dossierId);
    try {
      const r = await runSimulationAction(fd);
      if (!r.ok) setError(r.error ?? "La simulation n'a pas été lancée.");
      else if (!r.configured) setError(r.error ?? "IA non configurée — simulation indisponible.");
      else { setResult({ perspectives: r.perspectives, overall: r.overall ?? null, createdAt: new Date().toISOString() }); rafraichir(); }
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
        <strong>Simulation interne NON prédictive.</strong> Cet exercice anticipe des questions probables selon plusieurs
        perspectives d'examen ; il ne constitue en aucun cas une décision de l'ANPP ni une garantie de résultat.
      </p>
      <Button type="button" size="sm" disabled={busy} onClick={run}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Lancer la simulation multi-perspectives
      </Button>
      <Retour ton="erreur">{error}</Retour>

      {result && (
        <div className="space-y-2">
          {result.overall && <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"><strong>Synthèse simulée :</strong> {result.overall}</p>}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {result.perspectives.map((p, i) => (
              <div key={i} className="rounded-lg border border-border/60 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.perspective}</span>
                  <span className={`rounded px-1.5 py-0.5 ${VERDICT[p.verdict] ?? "bg-muted text-muted-foreground"}`}>{p.verdict} (simulé)</span>
                </div>
                {p.questions.length > 0 && <div className="mt-1"><span className="text-muted-foreground">Questions probables :</span><ul className="ml-3 list-disc">{p.questions.map((q, j) => <li key={j}>{q}</li>)}</ul></div>}
                {p.risks.length > 0 && <div className="mt-1"><span className="text-muted-foreground">Risques :</span><ul className="ml-3 list-disc">{p.risks.map((r, j) => <li key={j}>{r}</li>)}</ul></div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
