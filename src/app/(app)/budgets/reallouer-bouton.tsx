"use client";

/**
 * RÉALLOUER, HORS BUDGET MARKETING — le même panneau (`ReallouerSheet`) ouvert depuis l'en-tête du Budget Operations &
 * Sales et du Budget Regulatory, pour le directeur du budget (24/11/2026) ou qui gère l'enveloppe. Un geste, un panneau :
 * rien n'est recopié, la règle reste celle de `reallouerCategorie`.
 */

import * as React from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { arbreCategories, type CategorieBrute } from "@/lib/budget/marketing-vue";
import type { LigneDAutreEnveloppe } from "@/lib/budget/budget-du-directeur";
import { ReallouerSheet, type DemandeReallocation } from "./marketing-reallouer";

const AUCUNE: DemandeReallocation = {};

export function BoutonReallouer({ envelopeId, categoriesBrutes, autres }: {
  envelopeId: string;
  categoriesBrutes: CategorieBrute[];
  autres: LigneDAutreEnveloppe[];
}) {
  const [ouverte, setOuverte] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const tetes = React.useMemo(() => arbreCategories(categoriesBrutes), [categoriesBrutes]);
  if (tetes.length === 0) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOuverte(true)}>
        <ArrowLeftRight className="h-4 w-4" /> Réallouer
      </Button>
      {message && <span role="status" className="text-sm text-success">{message}</span>}
      <ReallouerSheet ouverte={ouverte} onClose={() => setOuverte(false)} tetes={tetes} envelopeId={envelopeId} initial={AUCUNE} onFait={setMessage} autres={autres} />
    </>
  );
}
