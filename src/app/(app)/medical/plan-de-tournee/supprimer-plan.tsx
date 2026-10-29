"use client";

import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { supprimerPlanTourneeBrouillon } from "@/lib/actions/tour-plan-actions";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

/**
 * SUPPRIMER UN BROUILLON — deux clics : « Supprimer », puis « Confirmer ».
 *
 * Proposé sur les seuls plans en brouillon ; l'action revérifie le statut, le périmètre et les visites déjà
 * rapportées (qui ne se suppriment jamais) et c'est son refus qui s'affiche ici.
 */
export function SupprimerPlan({ planId }: { planId: string }) {
  const [confirmer, setConfirmer] = React.useState(false);
  const { busy, err, setErr, run } = useAction();

  const supprimer = async () => {
    const fd = new FormData();
    fd.set("planId", planId);
    const ok = await run(async () => {
      const r = await supprimerPlanTourneeBrouillon(fd);
      return r.ok ? r : { ...r, error: r.error ?? "Suppression impossible." };
    });
    if (!ok) setConfirmer(false);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Retour ton="erreur" className="py-1 text-xs">{err}</Retour>
      {confirmer ? (
        <>
          <button
            type="button" onClick={() => void supprimer()} disabled={busy}
            className="inline-flex min-h-10 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:opacity-90 sm:min-h-0 sm:py-1"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Confirmer la suppression
          </button>
          <button
            type="button" onClick={() => setConfirmer(false)} disabled={busy}
            className="inline-flex min-h-10 items-center text-xs text-muted-foreground hover:underline sm:min-h-0"
          >
            Annuler
          </button>
        </>
      ) : (
        <button
          type="button" onClick={() => { setErr(null); setConfirmer(true); }}
          className="inline-flex min-h-10 items-center gap-1 text-xs text-destructive hover:underline sm:min-h-0"
        >
          <Trash2 className="h-3.5 w-3.5" /> Supprimer
        </button>
      )}
    </span>
  );
}
