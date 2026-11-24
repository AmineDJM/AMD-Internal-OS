"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { ouvrirActualisationSoldes } from "@/modules/finances/actions-soldes";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";

/**
 * « ACTUALISER LES SOLDES » — le geste des Finances (maquette validée du 24/11/2026). Il ouvre la saisie compte par
 * compte (`/finances/actualisation-soldes/<id>`) : la demande du Super Admin si elle attend, sinon une saisie ouverte
 * par les Finances elles-mêmes (`ouvrirActualisationSoldes`). Le même écran de saisie, quel que soit le chemin.
 */
export function ActualiserSoldesButton({ entiteId, discret = false }: { entiteId: string | null; discret?: boolean }) {
  const router = useRouter();
  const { busy, err, run } = useAction({ signalerErreurs: discret });
  const ouvrir = () => run(async () => {
    const fd = new FormData();
    if (entiteId) fd.set("entite", entiteId);
    const r = await ouvrirActualisationSoldes(fd);
    if (r.ok && r.id) router.push(`/finances/actualisation-soldes/${r.id}`);
    return r;
  });
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant={discret ? "ghost" : "outline"} className={discret ? "justify-start" : undefined} disabled={busy} onClick={() => void ouvrir()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Actualiser les soldes
      </Button>
      {!discret && <Retour ton="erreur">{err}</Retour>}
    </div>
  );
}
