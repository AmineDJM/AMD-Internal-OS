"use client";

import * as React from "react";
import { agirQualite, lancerBalayageQualite } from "@/platform/in-process/quality/actions";
import { Button } from "@/components/ui/button";
import { useSaisir } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * LES GESTES DE L'ÉCRAN QUALITÉ — corriger d'un clic ce qui est proposé, écarter avec un motif,
 * rouvrir, lancer un balayage. Chaque geste passe par l'action serveur, qui revérifie les droits
 * et écrit l'audit ; l'écran affiche mot pour mot ce que le serveur a répondu.
 */
export function BoutonsConstat({ id, status, aCorrection }: { id: string; status: string; aCorrection: boolean }) {
  const { rafraichir } = useRafraichir();
  const saisir = useSaisir();
  const [pending, start] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const agir = (geste: "corriger" | "ignorer" | "rouvrir", motif?: string) => start(async () => {
    try {
      const r = await agirQualite(id, geste, motif ?? null);
      setMessage(r.message);
      if (r.ok) rafraichir();
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    }
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="qualite-boutons">
      {status === "OPEN" && aCorrection && (
        <Button size="sm" disabled={pending} onClick={() => agir("corriger")} data-testid="qualite-corriger">Corriger</Button>
      )}
      {status === "OPEN" && (
        <Button size="sm" variant="outline" disabled={pending} data-testid="qualite-ecarter" onClick={async () => {
          const motif = await saisir({
            titre: "Pourquoi ce n'est pas une anomalie ? (le motif reste avec le constat)",
            confirmer: "Écarter",
            saisie: { libelle: "Motif", obligatoire: true, multiligne: true },
          });
          if (motif && motif.trim()) agir("ignorer", motif.trim());
        }}>Écarter</Button>
      )}
      {status !== "OPEN" && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => agir("rouvrir")}>Rouvrir</Button>
      )}
      {message && <span className="text-xs text-muted-foreground" data-testid="qualite-message">{message}</span>}
    </div>
  );
}

export function BoutonBalayage() {
  const { rafraichir } = useRafraichir();
  const [pending, start] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={pending} data-testid="qualite-balayer" onClick={() => start(async () => {
        try {
          const r = await lancerBalayageQualite("FULL");
          setMessage(r.message);
          if (r.ok) rafraichir();
        } catch {
          setMessage(actionFailureMessage("THROWN"));
        }
      })}>{pending ? "Balayage en cours…" : "Lancer un balayage complet"}</Button>
      {message && <span className="text-xs text-muted-foreground" data-testid="qualite-balayage-message">{message}</span>}
    </div>
  );
}
