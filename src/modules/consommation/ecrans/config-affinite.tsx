"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { enregistrerAffiniteConfig } from "@/lib/actions/consommation-actions";

const PERIODES = [
  ["MOIS", "Dernier mois disponible"], ["ROLLING_3M", "3 mois glissants"], ["ROLLING_6M", "6 mois glissants"],
  ["ROLLING_12M", "12 mois glissants"], ["PERSONNALISEE", "Période personnalisée"],
] as const;

/** Régler le DÉNOMINATEUR (le marché pertinent) et la PÉRIODE de l'affinité d'un produit. */
export function ConfigAffiniteForm({ produits, productId, initial }: {
  produits: { id: string; nom: string }[]; productId: string;
  initial: { productIds: string[]; molecules: string; periode: string; debut: string; fin: string } | null;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [panier, setPanier] = React.useState<string[]>(initial?.productIds ?? []);
  const [molecules, setMolecules] = React.useState(initial?.molecules ?? "");
  const [periode, setPeriode] = React.useState(initial?.periode ?? "ROLLING_12M");
  const [debut, setDebut] = React.useState(initial?.debut ?? "");
  const [fin, setFin] = React.useState(initial?.fin ?? "");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [ajout, setAjout] = React.useState("");
  return (
    <form
      className="surface space-y-3 p-3 sm:p-4"
      onSubmit={async (e) => { e.preventDefault(); setErreur(null); const r = await enregistrerAffiniteConfig({ productId, productIds: panier, molecules, periode, debut, fin }); if (!r.ok) setErreur(r.error); else rafraichir(); }}
    >
      <h2 className="text-sm font-semibold">Marché de référence (dénominateur)</h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {panier.map((id) => (
          <span key={id} className="inline-flex max-w-full items-center rounded-md border border-border py-0.5 pl-2 text-xs">
            <span className="min-w-0 [overflow-wrap:anywhere]">{produits.find((p) => p.id === id)?.nom ?? id}</span>{" "}
            <button type="button" aria-label="Retirer du marché" className="px-2.5 py-1.5 text-muted-foreground sm:px-1.5 sm:py-0" onClick={() => setPanier(panier.filter((x) => x !== id))}>×</button>
          </span>
        ))}
        <Select value={ajout} onChange={(e) => { const v = e.target.value; if (v && !panier.includes(v)) setPanier([...panier, v]); setAjout(""); }} className="w-full sm:w-56">
          <option value="">Ajouter un produit…</option>
          {produits.filter((p) => p.id !== productId && !panier.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3"><Label>Molécules du marché (séparées par des virgules — concurrents compris)</Label><Input value={molecules} onChange={(e) => setMolecules(e.target.value)} placeholder="ex. dolutégravir, raltégravir, darunavir" /></div>
        <div><Label>Période</Label><Select value={periode} onChange={(e) => setPeriode(e.target.value)}>{PERIODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
        {periode === "PERSONNALISEE" && <div><Label>Du</Label><Input type="date" value={debut} onChange={(e) => setDebut(e.target.value)} /></div>}
        {periode === "PERSONNALISEE" && <div><Label>Au</Label><Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} /></div>}
      </div>
      <p className="text-xs text-muted-foreground">Le produit étudié est toujours compté dans le marché. Seules des quantités de même unité sont comparées.</p>
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
      <Button size="sm" type="submit" disabled={enCours}>Enregistrer</Button>
    </form>
  );
}
