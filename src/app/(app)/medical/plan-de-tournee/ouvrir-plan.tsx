"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { ouvrirPlanTournee } from "@/lib/actions/tour-plan-actions";
import { GRANULARITE_LABELS, type Granularite } from "@/lib/sfe/tournee";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";

/**
 * OUVRIR LE PLAN DE LA PÉRIODE À VENIR — un seul bouton, une seule question.
 *
 * L'action est IDEMPOTENTE : si le plan existe, c'est celui-là qui s'ouvre. Le bouton ne demande
 * donc pas « créer ou ouvrir ? » — cette question n'a pas de réponse utile pour la personne, et
 * la lui poser ferait deux clics là où un suffit.
 */
export function OuvrirPlan({
  granularite, labelPeriodeSuivante, dateSuivante,
}: {
  granularite: Granularite;
  labelPeriodeSuivante: string;
  dateSuivante: string;
}) {
  const router = useRouter();
  const { busy, err, run } = useAction();

  const ouvrir = async () => {
    const fd = new FormData();
    fd.set("granularity", granularite);
    fd.set("date", dateSuivante);
    let planId: string | undefined;
    const ok = await run(async () => {
      const r = await ouvrirPlanTournee(fd);
      planId = r.id;
      return r.ok ? r : { ...r, error: r.error ?? "Ouverture impossible." };
    });
    if (ok && planId) router.push(`/medical/plan-de-tournee?plan=${planId}`);
  };

  return (
    <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <Retour ton="erreur" className="py-1 text-xs">{err}</Retour>
      <Button size="sm" className="h-auto min-h-12 w-full whitespace-normal py-2 text-sm leading-tight sm:min-h-0 sm:h-8 sm:w-auto sm:whitespace-nowrap sm:py-0 sm:text-xs" onClick={() => void ouvrir()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Préparer {GRANULARITE_LABELS[granularite].toLowerCase() === "mensuelle" ? "le mois" : "la période"} {labelPeriodeSuivante}
      </Button>
    </span>
  );
}
