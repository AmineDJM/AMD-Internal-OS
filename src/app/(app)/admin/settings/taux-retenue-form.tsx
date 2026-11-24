"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { reglerTauxRetenue } from "@/modules/finances/actions-natures";
import {
  LIBELLE_REGIME_RETENUE, MENTION_A_CONFIRMER, REGIMES_RETENUE, type RegimeRetenueSource, type TauxRetenue,
} from "@/modules/finances/partage";

/**
 * LES TAUX DE RETENUE À LA SOURCE (24/11/2026) — un par régime. Tant que la case « confirmé par le cabinet » n'est pas
 * cochée, le taux s'affiche partout « à confirmer par le cabinet ». Un taux changé vaut pour les paiements demandés
 * ensuite : un ordre déjà né garde le sien.
 */
export function TauxRetenueForm({ taux }: { taux: Record<RegimeRetenueSource, TauxRetenue> }) {
  return (
    <div className="space-y-3">
      {REGIMES_RETENUE.map((r) => <LigneTaux key={r} regime={r} initial={taux[r]} />)}
    </div>
  );
}

function LigneTaux({ regime, initial }: { regime: RegimeRetenueSource; initial: TauxRetenue }) {
  const [valeur, setValeur] = React.useState(String(initial.taux));
  const [confirme, setConfirme] = React.useState(initial.confirmeParCabinet);
  const { busy, err, run } = useAction();
  const enregistrer = () => {
    const fd = new FormData();
    fd.set("regime", regime);
    fd.set("taux", valeur);
    if (confirme) fd.set("confirmeParCabinet", "on");
    void run(() => reglerTauxRetenue(fd), undefined, { succes: "Taux enregistré." });
  };
  const id = `taux-${regime}`;
  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={id}>{LIBELLE_REGIME_RETENUE[regime]}</Label>
          {!initial.confirmeParCabinet && <p className="text-xs text-warning">{MENTION_A_CONFIRMER}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <Input id={id} value={valeur} onChange={(e) => setValeur(e.target.value)} inputMode="decimal" className="w-24 text-right tabular-nums" />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={confirme} onChange={(e) => setConfirme(e.target.checked)} />
          Confirmé par le cabinet
        </label>
        <Button type="button" size="sm" disabled={busy} onClick={enregistrer}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
        </Button>
      </div>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
