"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { setSeparationTachesPaiement } from "@/lib/actions/settings-actions";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

/**
 * LA SÉPARATION DES TÂCHES AU CENTRE DE PAIEMENT (audit 27/10, ARGENT-06) — active par défaut. La suspendre
 * demande une confirmation explicite : c'est rouvrir la possibilité qu'un même compte demande, autorise et règle.
 */
export function SeparationTachesToggle({ active: initial }: { active: boolean }) {
  const [active, setActive] = React.useState(initial);
  const { busy, err, run } = useAction();
  function basculer(next: boolean) {
    void run(() => setSeparationTachesPaiement(next), () => setActive(next), next ? undefined : {
      confirmer: { titre: "Suspendre la séparation des tâches ?", message: "Un même compte pourra demander, autoriser et régler un paiement.", confirmer: "Suspendre", ton: "danger" },
    });
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Qui demande n&apos;autorise pas ; qui demande ou autorise ne règle pas</p>
          <p className="text-xs text-muted-foreground">
            {active
              ? "Active : un siège du centre n'autorise pas sa propre demande, et la comptabilité ne règle pas ce qu'elle a demandé ou autorisé."
              : "Suspendue : un même compte peut demander, autoriser et régler. À rétablir dès qu'un second siège est nommé."}
          </p>
        </div>
        <button
          type="button" role="switch" aria-checked={active} disabled={busy}
          aria-label="Séparation des tâches au centre de paiement"
          onClick={() => basculer(!active)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${active ? "bg-primary" : "bg-input"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${active ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      {busy && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Mise à jour…</p>}
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
