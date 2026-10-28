"use client";

import * as React from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { resoumettreAuCentreAdPro } from "../actions-centre";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";

/**
 * Resoumettre au centre une demande qu'il a renvoyée — ce qui a été corrigé est exigé, et le
 * MONTANT (ce que le centre arbitre) se corrige ici : ces natures n'ont pas d'autre écran d'édition.
 * Il revient pré-rempli ; le laisser tel quel, c'est ne pas le changer.
 */
export function ResoumettreAuCentre({ entityType, entityId, montant }: {
  entityType: string; entityId: string; montant: number | null;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        const fd = new FormData(e.currentTarget);
        fd.set("entityType", entityType); fd.set("entityId", entityId);
        const r = await resoumettreAuCentreAdPro(fd);
        setBusy(false);
        if (!r.ok) { setError(r.error ?? "Échec."); return; }
        rafraichir();
      }}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
        <Input
          name="note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Ce que vous avez corrigé"
          placeholder="Ce que vous avez corrigé (obligatoire)" className="min-w-0"
        />
        <Input
          name="amount" type="number" inputMode="decimal" min={0} step="any" aria-label="Montant corrigé (DZD)"
          defaultValue={montant == null ? "" : String(montant)} placeholder="Montant (DZD)"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="h-10 w-full sm:h-8 sm:w-auto" disabled={busy || enCours || !note.trim()}>
          {busy || enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Resoumettre au centre
        </Button>
        <span className="text-xs text-muted-foreground">Corrigé sous le seuil, il ne repasse pas par le centre.</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
