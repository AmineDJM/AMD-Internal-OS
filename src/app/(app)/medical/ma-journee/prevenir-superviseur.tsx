"use client";

import * as React from "react";
import { BellRing, Loader2 } from "lucide-react";
import { prevenirSuperviseurPanelVide } from "@/lib/actions/visite-medicale-actions";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";

/**
 * « PRÉVENIR MON SUPERVISEUR » — le remède d'un panel vide (11/2026). L'action relit la cause au serveur et la porte
 * au superviseur de la BU (à défaut, au N+1) ; l'écran dit qui a été prévenu.
 */
export function PrevenirSuperviseur() {
  const { busy, err, run } = useAction();
  const [fait, setFait] = React.useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <Button
        variant="outline" className="h-11 w-full sm:h-9 sm:w-auto" disabled={busy || fait !== null}
        onClick={() => run(async () => {
          const r = await prevenirSuperviseurPanelVide();
          if (r.ok) setFait(r.message ?? "Votre superviseur est prévenu.");
          return r;
        })}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />} Prévenir mon superviseur
      </Button>
      {fait && <p role="status" className="text-sm text-success">{fait}</p>}
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
    </div>
  );
}
