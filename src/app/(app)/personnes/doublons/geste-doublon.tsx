"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Button } from "@/components/ui/button";
import { defaireFusionPersonne, ecarterDoublonPersonne, fusionnerDoublonPersonne } from "@/modules/referentiels/actions-personnes";
import type { ActionResult } from "@/lib/actions/types";

type Props =
  | { doublonId: string; defaire: true; a?: undefined; b?: undefined }
  | { doublonId: string; defaire?: false; a: { id: string; nom: string }; b: { id: string; nom: string } };

/** Trancher une proposition : garder l'une des deux, écarter — ou défaire une fusion. */
export function GesteDoublon(p: Props) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setBusy] = React.useState(false);
  const busy = occupe || enCours;
  const [erreur, setErreur] = React.useState<string | null>(null);
  const confirmer = useConfirmer();
  const agir = async (geste: () => Promise<ActionResult>, confirmation: string) => {
    if (!(await confirmer(confirmation))) return;
    setBusy(true); setErreur(null);
    try {
      const r = await geste();
      if (!r.ok) setErreur(r.error ?? "La proposition de doublon n'a pas été tranchée.");
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };
  if (p.defaire) {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => agir(() => defaireFusionPersonne(p.doublonId), "Défaire cette fusion ? Les fiches déplacées reviennent à la Personne absorbée.")}>
        Défaire
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {[p.a, p.b].map((g) => (
        <Button key={g.id} size="sm" disabled={busy} onClick={() => agir(() => fusionnerDoublonPersonne(p.doublonId, g.id), `Garder « ${g.nom} » et y fusionner l'autre fiche ?`)}>
          Garder « {g.nom} »
        </Button>
      ))}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => agir(() => ecarterDoublonPersonne(p.doublonId), "Écarter : ce ne sont pas les mêmes personnes. La paire ne sera plus proposée.")}>
        Pas les mêmes
      </Button>
      {erreur && <span className="text-sm text-destructive">{erreur}</span>}
    </div>
  );
}
