"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, Label } from "@/components/ui/input";
import { creerStrategie } from "@/lib/actions/segmentation-actions";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * ACTIVER LA SEGMENTATION D'UNE BU (Direction, 06/10 : « une porte de vérité ») — ni BU ni stratégie à inventer ici :
 * la BU est celle de la Force de vente, la stratégie porte son nom, et les produits se classent (trois au plus) parmi
 * ceux de son CATALOGUE. Un produit absent du catalogue s'ajoute dans Force de vente › Business Units.
 */
export function CreerStrategie({ bu, produits }: { bu: { id: string; nom: string }; produits: { id: string; nom: string; dci: string }[] }) {
  const router = useRouter();
  const [choix, setChoix] = React.useState<string[]>(["", "", ""]);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const ids = choix.filter(Boolean);

  async function activer(e: React.FormEvent) {
    e.preventDefault();
    setEnvoi(true); setErreur(null);
    try {
      const r = await creerStrategie({ businessUnitId: bu.id, nom: bu.nom, productIds: ids });
      if (!r.ok) setErreur(r.error); else router.push(`/segmentation/import?bu=${bu.id}`);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }

  if (produits.length === 0) {
    return (
      <p className="surface p-5 text-sm text-muted-foreground">
        Le catalogue de la BU {bu.nom} n&apos;a aucun produit rattaché au référentiel : ajoutez-les dans{" "}
        <Link href="/planning/business-units" className="text-primary underline">Force de vente › Business Units</Link>, puis revenez activer la segmentation.
      </p>
    );
  }
  return (
    <form onSubmit={activer} className="surface max-w-2xl space-y-3 p-5">
      <p className="text-sm text-muted-foreground">
        Activer la segmentation de la BU <b className="text-foreground">{bu.nom}</b> : classez jusqu&apos;à trois produits de son catalogue. Le catalogue se tient dans{" "}
        <Link href="/planning/business-units" className="text-primary underline">Force de vente › Business Units</Link>.
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <Label>Produit #{i + 1}{i > 0 ? " (facultatif)" : ""}</Label>
          <Select value={choix[i]} onChange={(e) => setChoix(choix.map((c, j) => (j === i ? e.target.value : c)))}>
            <option value="">—</option>
            {produits.filter((p) => p.id === choix[i] || !choix.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.nom}{p.dci && p.dci.toLowerCase() !== p.nom.toLowerCase() ? ` (${p.dci})` : ""}</option>)}
          </Select>
        </div>
      ))}
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
      <Button type="submit" disabled={envoi || ids.length === 0}>Activer la segmentation</Button>
    </form>
  );
}
