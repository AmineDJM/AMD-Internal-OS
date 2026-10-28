"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { confirmerFait, rejeterFait, trancherConflit } from "@/lib/actions/enrichissement-actions";
import { Button } from "@/components/ui/button";

/** Confirmer / rejeter un fait, ou trancher son conflit — le serveur revérifie la porte et écrit l'audit. */
export function GestesFait({ faitId, conflitId }: { faitId: string; conflitId: string | null }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState(false);
  const pending = occupe || enCours;
  const [message, setMessage] = React.useState<string | null>(null);
  const agir = (geste: () => Promise<{ ok: boolean; message: string }>) => void (async () => {
    setOccupe(true);
    try {
      const r = await geste();
      setMessage(r.message);
      if (r.ok) rafraichir();
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(false);
    }
  })();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {conflitId ? (
        <>
          <Button size="sm" disabled={pending} onClick={() => agir(() => trancherConflit(conflitId, "REMPLACER", null))}>Prendre la pièce</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => agir(() => trancherConflit(conflitId, "GARDER", null))}>Garder la fiche</Button>
        </>
      ) : (
        <>
          <Button size="sm" disabled={pending} onClick={() => agir(() => confirmerFait(faitId))}>Confirmer</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => {
            const motif = window.prompt("Pourquoi rejeter ce fait ? (facultatif)");
            if (motif !== null) agir(() => rejeterFait(faitId, motif));
          }}>Rejeter</Button>
        </>
      )}
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
