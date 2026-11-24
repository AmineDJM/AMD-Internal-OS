"use client";

import * as React from "react";
import { Loader2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { modifierReglagesPv } from "@/lib/actions/pharmacovigilance-actions";
import { AVERTISSEMENT_DELAIS_PV, BORNES_DELAI_PV } from "@/lib/pharmacovigilance/declaration";

/**
 * LES RÉGLAGES DE LA PHARMACOVIGILANCE (Super Admin seul) — les délais de déclaration à l'autorité, à confirmer par le
 * pharmacien responsable, et le pharmacien responsable désigné par société (il vise les déclarations).
 */
export function ReglagesPv({ delais, pharmaciens, societes, personnes }: {
  delais: { graveJours: number; nonGraveJours: number };
  pharmaciens: Record<string, string>;
  societes: { id: string; nom: string }[];
  personnes: { id: string; nom: string }[];
}) {
  const { busy, err, run } = useAction();
  const soumettre = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    void run(() => modifierReglagesPv(fd), undefined, { succes: "Réglages enregistrés." });
  };
  return (
    <details className="surface p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Settings2 className="h-4 w-4" /> Délais et pharmacien responsable</summary>
      <form onSubmit={soumettre} className="mt-3 space-y-4 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="pv-delai-grave">Cas grave (jours calendaires)</Label>
            <Input id="pv-delai-grave" type="number" name="delaiGraveJours" min={BORNES_DELAI_PV.min} max={BORNES_DELAI_PV.max} defaultValue={delais.graveJours} required />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="pv-delai-non-grave">Cas non grave (jours calendaires)</Label>
            <Input id="pv-delai-non-grave" type="number" name="delaiNonGraveJours" min={BORNES_DELAI_PV.min} max={BORNES_DELAI_PV.max} defaultValue={delais.nonGraveJours} required />
          </div>
        </div>
        <p className="text-xs text-warning">{AVERTISSEMENT_DELAIS_PV}</p>
        {societes.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Pharmacien responsable (vise les déclarations)</p>
            {societes.map((s) => (
              <div key={s.id} className="grid grid-cols-1 items-center gap-1 sm:grid-cols-2">
                <Label htmlFor={`pv-ph-${s.id}`} className="truncate">{s.nom}</Label>
                <Select id={`pv-ph-${s.id}`} name="designation" defaultValue={pharmaciens[s.id] ? `${s.id}:${pharmaciens[s.id]}` : ""}>
                  <option value="">Aucun (pas de visa)</option>
                  {personnes.map((p) => <option key={p.id} value={`${s.id}:${p.id}`}>{p.nom}</option>)}
                </Select>
              </div>
            ))}
          </div>
        )}
        <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Enregistrer les réglages
        </Button>
        {err && <Retour ton="erreur">{err}</Retour>}
      </form>
    </details>
  );
}
