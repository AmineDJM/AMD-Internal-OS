"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { DUREES, DUREE_LABELS } from "@/lib/segmentation/cycle";
import { ouvrirCycleSegmentation, cloreCycleSegmentation } from "@/lib/actions/segmentation-actions";

/** Ouvrir un cycle : début, durée (1 mois par défaut, réglable), libellé. Les règles du moment sont figées. */
export function OuvrirCycle({ strategieId }: { strategieId: string }) {
  const router = useRouter();
  const [debut, setDebut] = React.useState(() => new Date().toISOString().slice(0, 8) + "01");
  const [duree, setDuree] = React.useState<string>("MOIS");
  const [fin, setFin] = React.useState("");
  const [libelle, setLibelle] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  return (
    <form
      className="surface grid grid-cols-1 gap-3 p-3 sm:flex sm:flex-wrap sm:items-end sm:p-4"
      onSubmit={async (e) => {
        e.preventDefault(); setEnvoi(true); setErreur(null);
        try {
          const r = await ouvrirCycleSegmentation({ strategieId, debut, duree, fin, libelle });
          if (!r.ok) setErreur(r.error); else router.push(`/segmentation?s=${strategieId}&vue=cycles&cycle=${r.id}`);
        } catch {
          setErreur(actionFailureMessage("THROWN"));
        } finally {
          setEnvoi(false);
        }
      }}
    >
      <div><Label>Début</Label><Input type="date" value={debut} onChange={(e) => setDebut(e.target.value)} className="sm:w-40" /></div>
      <div><Label>Durée</Label><Select value={duree} onChange={(e) => setDuree(e.target.value)} className="sm:w-40">{DUREES.map((d) => <option key={d} value={d}>{DUREE_LABELS[d]}</option>)}</Select></div>
      {duree === "PERSONNALISE" && <div><Label>Fin</Label><Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} className="sm:w-40" /></div>}
      <div><Label>Libellé (facultatif)</Label><Input value={libelle} onChange={(e) => setLibelle(e.target.value)} placeholder="ex. Cycle octobre" className="sm:w-48" /></div>
      <Button type="submit" disabled={envoi || !debut}>Ouvrir le cycle</Button>
      {erreur && <p className="w-full text-sm text-destructive">{erreur}</p>}
      <p className="w-full text-xs text-muted-foreground">L&apos;ouverture fige la version des règles, les produits classés et le résultat de chaque praticien : les changer ensuite ne réécrit pas ce cycle.</p>
    </form>
  );
}

export function CloreCycle({ cycleId }: { cycleId: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [erreur, setErreur] = React.useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={enCours} onClick={async () => {
        setErreur(null);
        try {
          const r = await cloreCycleSegmentation(cycleId);
          if (!r.ok) setErreur(r.error); else rafraichir();
        } catch {
          setErreur(actionFailureMessage("THROWN"));
        }
      }}>Clore le cycle</Button>
      {erreur && <span className="text-xs text-destructive">{erreur}</span>}
    </span>
  );
}
