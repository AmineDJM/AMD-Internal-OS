"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { confirmerCorrespondanceConso, validerImportConso, annulerImportConso } from "@/lib/actions/consommation-actions";

export interface GroupeARevoir { nature: "ETABLISSEMENT" | "PRODUIT"; brut: string; lignes: number; proposition: { id: string; nom: string; pourquoi: string } | null }

/**
 * TRANCHER CE QUI N'EST PAS SÛR — une décision par valeur brute (« R400 » est ce produit, « CHU ORAN » est cet
 * établissement), appliquée à toutes ses lignes et mémorisée. Puis VALIDER : les lignes sûres comptent, les autres
 * restent hors du calcul (gardées, comptées, visibles).
 */
export function Revue({ importId, statut, groupes, etablissements, produits, peutRevoir, peutValider, aRevoir, sures }: {
  importId: string; statut: string; groupes: GroupeARevoir[];
  etablissements: { id: string; nom: string }[]; produits: { id: string; nom: string }[];
  peutRevoir: boolean; peutValider: boolean; aRevoir: number; sures: number;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  async function agir(f: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setEnvoi(true); setErreur(null);
    const r = await f();
    setEnvoi(false);
    if (!r.ok) setErreur(r.error); else rafraichir();
  }
  const occupe = envoi || enCours;
  return (
    <div className="space-y-3">
      {statut === "EN_REVUE" && groupes.length > 0 && (
        <section className="surface space-y-3 p-3 sm:space-y-2 sm:p-4">
          <h2 className="text-sm font-semibold">À trancher ({groupes.length})</h2>
          {groupes.map((g) => <Correspondance key={`${g.nature}|${g.brut}`} importId={importId} groupe={g} options={g.nature === "ETABLISSEMENT" ? etablissements : produits} peut={peutRevoir} occupe={occupe} agir={agir} />)}
          <p className="text-xs text-muted-foreground">Une correspondance confirmée s&apos;applique à toutes les lignes qui portent cette valeur, et sera proposée aux prochains fichiers.</p>
        </section>
      )}
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
      {statut === "EN_REVUE" && peutValider && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={occupe || sures === 0} onClick={() => agir(() => validerImportConso(importId))}>Valider : {sures} ligne(s) comptent</Button>
          {aRevoir > 0 && <span className="text-xs text-muted-foreground">{aRevoir} ligne(s) encore à revoir resteront hors du calcul.</span>}
          <button type="button" className="py-2 text-xs text-muted-foreground underline sm:py-0" disabled={occupe} onClick={() => agir(() => annulerImportConso(importId))}>Annuler l&apos;import</button>
        </div>
      )}
      {statut === "VALIDE" && peutValider && (
        <button type="button" className="py-2 text-left text-xs text-muted-foreground underline sm:py-0" disabled={occupe} onClick={() => agir(() => annulerImportConso(importId))}>Annuler cet import (ses lignes cessent de compter)</button>
      )}
    </div>
  );
}

function Correspondance({ importId, groupe, options, peut, occupe, agir }: { importId: string; groupe: GroupeARevoir; options: { id: string; nom: string }[]; peut: boolean; occupe: boolean; agir: (f: () => Promise<{ ok: true } | { ok: false; error: string }>) => Promise<void> }) {
  const [cible, setCible] = React.useState(groupe.proposition?.id ?? "");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
      <span className="w-28 text-xs text-muted-foreground">{groupe.nature === "ETABLISSEMENT" ? "Établissement" : "Produit"}</span>
      <span className="min-w-0 font-medium [overflow-wrap:anywhere] sm:min-w-40">« {groupe.brut} »</span>
      <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{groupe.lignes} ligne(s){groupe.proposition ? ` · proposé : ${groupe.proposition.nom} (${groupe.proposition.pourquoi})` : ""}</span>
      {peut && (
        <>
          <Select value={cible} onChange={(e) => setCible(e.target.value)} className="w-full sm:w-64">
            <option value="">Choisir…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.nom}</option>)}
          </Select>
          {cible && <Button size="sm" disabled={occupe} onClick={() => agir(() => confirmerCorrespondanceConso({ importId, nature: groupe.nature, brut: groupe.brut, cibleId: cible }))}>Confirmer</Button>}
        </>
      )}
    </div>
  );
}
