"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { updateRiskThresholds } from "@/lib/actions/adventum-actions";
import { THRESHOLD_FIELDS, type RiskThresholds } from "@/lib/adventum/risk-thresholds";

/** « ⋯ › Seuils des détecteurs » — le réglage, dans une feuille (jamais sur la page). */
export function RiskThresholdsForm({ initial }: { initial: RiskThresholds }) {
  const [ouvert, setOuvert] = React.useState(false);
  const [envoi, setEnvoi] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const { enCours, rafraichir } = useRafraichir();

  return (
    <>
      <button type="button" role="menuitem" onClick={() => setOuvert(true)} className="rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary">Seuils des détecteurs</button>
      <Sheet open={ouvert} onClose={() => setOuvert(false)} title="Seuils des détecteurs" description="Quand un risque se déclenche." width="lg">
        <form
          action={async (fd) => {
            setEnvoi(true); setErr(null);
            try {
              const r = await updateRiskThresholds(fd);
              if (r.ok) { setOuvert(false); rafraichir(); } else setErr(r.error ?? "Enregistrement impossible.");
            } catch {
              setErr(actionFailureMessage("THROWN"));
            } finally {
              setEnvoi(false);
            }
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {THRESHOLD_FIELDS.map((f) => (
              <label key={f.key} className="space-y-1" title={f.help}>
                <span className="block text-xs font-medium">{f.label}</span>
                <span className="flex items-center gap-1.5">
                  <input
                    type="number" inputMode="numeric" name={f.key} defaultValue={initial[f.key]} min={f.min} max={f.max}
                    className="h-10 w-24 rounded-lg border border-input bg-background px-2.5 text-base shadow-sm sm:h-9 sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span className="text-xs text-muted-foreground">{f.suffix}</span>
                </span>
              </label>
            ))}
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={envoi || enCours}>{envoi && <Loader2 className="h-4 w-4 animate-spin" />}Enregistrer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
