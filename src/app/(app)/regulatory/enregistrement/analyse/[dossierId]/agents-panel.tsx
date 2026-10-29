"use client";

import { courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Loader2, Bot, ShieldQuestion, CheckCircle2 } from "lucide-react";
import { runAgentAction } from "@/lib/regulatory/intelligence/agents/actions";

interface AgentItem { key: string; name: string; requiresSource: boolean }
interface RunState { status: "abstained" | "done" | "error"; message: string }

/**
 * Panneau des agents spécialisés (G6) — exécution À LA DEMANDE. Chaque agent produit des
 * constats PROJET (revue humaine requise) ou s'abstient si aucune source active ne fonde une
 * conclusion. Jamais autonome, jamais bloquant.
 */
export function AgentsPanel({ dossierId, agents, configured, cleIa = null }: { dossierId: string; agents: AgentItem[]; configured: boolean; /** Le nom de la clé manquante, lu côté serveur (§118.128). */ cleIa?: string | null }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, RunState>>({});

  async function run(agentKey: string) {
    setBusy(agentKey);
    const fd = new FormData(); fd.set("dossierId", dossierId); fd.set("agentKey", agentKey);
    try {
      const r = await runAgentAction(fd);
      if (!r.ok) setResults((s) => ({ ...s, [agentKey]: { status: "error", message: r.error ?? "L'agent n'a pas été lancé." } }));
      else if (r.abstained) setResults((s) => ({ ...s, [agentKey]: { status: "abstained", message: r.message ?? "Abstention." } }));
      else { setResults((s) => ({ ...s, [agentKey]: { status: "done", message: `${r.findings} constat(s) PROJET ajouté(s).` } })); rafraichir(); }
    } catch {
      setResults((s) => ({ ...s, [agentKey]: { status: "error", message: actionFailureMessage("THROWN") } }));
    } finally {
      setBusy(null);
    }
  }

  if (!configured) {
    return (
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
        {courtIaNonConfiguree(cleIa)} : les agents spécialisés ne s'exécutent pas et aucune analyse n'est simulée.
        Les contrôles déterministes (règles, complétude, faits) restent pleinement opérationnels.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Chaque agent examine son périmètre en s'appuyant sur le corpus réglementaire <strong>actif</strong> (citations).
        Résultat = <strong>PROJET soumis à revue humaine</strong>. Si aucune source active ne fonde une conclusion, l'agent
        s'abstient (« EXIGENCE NON CONFIRMÉE — REVUE HUMAINE REQUISE »).
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {agents.map((a) => {
          const r = results[a.key];
          return (
            <div key={a.key} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
              <Bot className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={a.name}>{a.name}</p>
                {r && (
                  <p className={`flex items-center gap-1 text-[0.6875rem] ${r.status === "abstained" ? "text-amber-600" : r.status === "error" ? "text-destructive" : "text-success"}`}>
                    {r.status === "abstained" ? <ShieldQuestion className="h-3 w-3" /> : r.status === "done" ? <CheckCircle2 className="h-3 w-3" /> : null}
                    {r.message}
                  </p>
                )}
              </div>
              <button type="button" disabled={busy !== null} onClick={() => run(a.key)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50 sm:px-2 sm:py-1">
                {busy === a.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Analyser"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
