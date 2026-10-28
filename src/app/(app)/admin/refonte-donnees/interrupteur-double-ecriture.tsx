"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { basculerDoubleEcriturePersonnes } from "@/lib/actions/personnes-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * L'INTERRUPTEUR DE LA DOUBLE ÉCRITURE DES PERSONNES. Allumé : chaque création de salarié, praticien,
 * bénéficiaire, voyageur… crée ou relie sa Personne dans la même transaction. Éteint : les écrivains
 * font exactement ce qu'ils faisaient avant. À allumer APRÈS la reprise des tables.
 */
export function InterrupteurDoubleEcriturePersonnes({ actif }: { actif: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setBusy] = React.useState(false);
  const busy = occupe || enCours;
  const [message, setMessage] = React.useState<string | null>(null);
  const basculer = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await basculerDoubleEcriturePersonnes(!actif);
      setMessage(r.ok ? r.message ?? null : r.error ?? "Échec.");
      if (r.ok) rafraichir();
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span>Double écriture des Personnes :</span>
      <Badge tone={actif ? "success" : "neutral"}>{actif ? "allumée" : "éteinte"}</Badge>
      <Button size="sm" variant={actif ? "outline" : "primary"} disabled={busy} onClick={() => void basculer()}>
        {actif ? "Éteindre" : "Allumer"}
      </Button>
      {message && <span className="text-muted-foreground">{message}</span>}
    </div>
  );
}
