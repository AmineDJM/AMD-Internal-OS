"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { defaireFusionOrganisation, ecarterDoublonOrganisation, fusionnerOrganisations } from "@/modules/referentiels/actions-organisations";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/actions/types";

/** Trancher une paire : garder l'une (l'autre y est fusionnée), ou écarter. Le serveur revérifie et audite. */
export function TrancherDoublon({ propositionId, a, b }: { propositionId: string; a: { id: string; nom: string }; b: { id: string; nom: string } }) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const pending = busy || enCours;
  const [message, setMessage] = React.useState<string | null>(null);
  const confirmer = useConfirmer();
  const agir = (geste: (fd: FormData) => Promise<ActionResult>, champs: Record<string, string>, confirmation?: string) => {
    void (async () => {
      if (confirmation && !(await confirmer(confirmation))) return;
      setBusy(true);
      const fd = new FormData();
      fd.set("propositionId", propositionId);
      for (const [k, v] of Object.entries(champs)) fd.set(k, v);
      try {
        const r = await geste(fd);
        setMessage(r.ok ? null : r.error ?? "Refusé.");
        if (r.ok) rafraichir();
      } catch {
        setMessage(actionFailureMessage("THROWN"));
      } finally {
        setBusy(false);
      }
    })();
  };
  const garder = (s: { id: string; nom: string }, o: { id: string; nom: string }) =>
    agir(fusionnerOrganisations, { survivanteId: s.id }, `Garder « ${s.nom} » et y fusionner « ${o.nom} » ? Rien n'est effacé : la fusion se défait.`);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" disabled={pending} onClick={() => garder(a, b)} data-testid="doublon-garder-a">Garder la 1re</Button>
      <Button size="sm" disabled={pending} onClick={() => garder(b, a)} data-testid="doublon-garder-b">Garder la 2de</Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => agir(ecarterDoublonOrganisation, {})} data-testid="doublon-ecarter">Pas les mêmes</Button>
      {message && <span className="text-xs text-destructive">{message}</span>}
    </div>
  );
}

export function DefaireFusion({ organisationId }: { organisationId: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const defaire = async () => {
    setBusy(true);
    const fd = new FormData();
    fd.set("organisationId", organisationId);
    try {
      const r = await defaireFusionOrganisation(fd);
      setMessage(r.ok ? null : r.error ?? "Refusé.");
      if (r.ok) rafraichir();
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button size="sm" variant="ghost" disabled={busy || enCours} onClick={() => void defaire()}>Défaire</Button>
      {message && <span className="text-xs text-destructive">{message}</span>}
    </span>
  );
}
