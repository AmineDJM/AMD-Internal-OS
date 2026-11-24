"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { choisirNatureDemande } from "@/modules/finances/actions-natures";
import type { RegimeRetenueSource, TauxRetenue } from "@/modules/finances/partage";
import { NatureDepenseChamp } from "../nature-depense-champ";

/**
 * LA NATURE D'UNE DEMANDE QUI N'A PAS ENCORE D'ORDRE (24/11/2026) — le brouillon d'avant la règle ne se transmet plus sans
 * elle ; une fois l'ordre né, elle ne se change plus ici (le serveur le refuse et dit pourquoi).
 */
export function NatureAChoisir({ id, actuelle, montant, taux }: {
  id: string; actuelle: string | null; montant: number; taux: Record<RegimeRetenueSource, TauxRetenue>;
}) {
  const [nature, setNature] = React.useState(actuelle ?? "");
  const { busy, err, run } = useAction();
  const enregistrer = () => {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("natureDepense", nature);
    void run(() => choisirNatureDemande(fd), undefined, { succes: "Nature enregistrée." });
  };
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <NatureDepenseChamp id="dossier-nature-depense" value={nature} onChange={setNature} montant={montant} taux={taux} />
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={busy || !nature || nature === actuelle} onClick={enregistrer}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la nature
        </Button>
      </div>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
