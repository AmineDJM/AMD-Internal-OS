"use client";

import * as React from "react";
import { Check, Loader2, RefreshCw, X } from "lucide-react";
import { relancerAnalyseInfluence, deciderLienInfluence } from "@/lib/actions/intelligence-terrain-actions";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useAction } from "@/components/shared/use-action";
import { actionFailureMessage } from "@/lib/action-outcome";

/** « Relancer l'analyse » — structure, nouveaux rapports (Luna), scores. Le bilan s'affiche en une ligne. */
export function RelancerAnalyse() {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const lancer = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await relancerAnalyseInfluence();
      if (!r.ok) { setMsg(r.error ?? "L'analyse n'a pas été relancée."); return; }
      const b = r.bilan;
      if (b) setMsg(`${b.rapportsLus} rapport(s) lu(s) · ${b.liensProposes} lien(s) proposé(s)${b.luna === "INDISPONIBLE" ? " · Luna indisponible" : b.luna === "ECHEC" ? " · Luna n'a pas répondu" : ""}${b.resteALire ? " · reste à lire" : ""}`);
      rafraichir();
    } catch {
      setMsg(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={lancer} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Relancer l&apos;analyse
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}

/** Confirmer / rejeter un lien proposé par Luna. */
export function DecisionLien({ relationId }: { relationId: string }) {
  const { busy, err, run } = useAction();
  const decider = async (decision: "CONFIRMEE" | "REJETEE") => {
    const fd = new FormData();
    fd.set("relationId", relationId);
    fd.set("decision", decision);
    await run(async () => {
      const r = await deciderLienInfluence(fd);
      return r.ok ? r : { ok: false, error: r.error ?? (decision === "CONFIRMEE" ? "Le lien n'a pas été confirmé." : "Le lien n'a pas été rejeté.") };
    });
  };
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" onClick={() => decider("CONFIRMEE")} disabled={busy} aria-label="Confirmer le lien">
        <Check className="h-4 w-4" /> Confirmer
      </Button>
      <Button size="sm" variant="ghost" onClick={() => decider("REJETEE")} disabled={busy} aria-label="Rejeter le lien">
        <X className="h-4 w-4" /> Rejeter
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
