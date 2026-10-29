"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { verifierProduitsDesDossiers } from "@/lib/actions/produit-canonique-actions";
import type { BilanProduitsDesDossiers } from "@/lib/products/canonique";

/**
 * « VÉRIFIER LE CATALOGUE » — Super Admin (menu ⋯ de Produits 360). Le même passage qu'au démarrage du serveur :
 * chaque dossier non verrouillé a son produit. Il rend son bilan, dont les produits qu'un ancien rattachement a
 * fait partager à plusieurs dossiers — listés, jamais scindés d'office.
 */
export function VerifierCatalogue() {
  const { enCours, rafraichir } = useRafraichir();
  const [envoi, setEnvoi] = React.useState(false);
  const [bilan, setBilan] = React.useState<BilanProduitsDesDossiers | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);

  async function verifier() {
    setEnvoi(true); setErreur(null);
    try {
      const r = await verifierProduitsDesDossiers();
      if (!r.ok) { setErreur(r.error); return; }
      setBilan(r.bilan);
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }

  const occupe = envoi || enCours;
  return (
    <div className="space-y-1.5">
      <button type="button" role="menuitem" onClick={verifier} disabled={occupe}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary disabled:opacity-60">
        {occupe ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4 text-muted-foreground" />}
        Vérifier le catalogue
      </button>
      {erreur && <p role="alert" className="px-2 text-xs text-destructive">{erreur}</p>}
      {bilan && (
        <div role="status" className="space-y-1 px-2 text-xs text-muted-foreground">
          <p>
            {bilan.dossiers} dossier{bilan.dossiers > 1 ? "s" : ""} · {bilan.crees} produit{bilan.crees > 1 ? "s" : ""} créé{bilan.crees > 1 ? "s" : ""}
            {" "}· {bilan.misAJour} mis à jour · {bilan.aCompleter} à compléter{bilan.erreurs ? ` · ${bilan.erreurs} erreur(s)` : ""}
          </p>
          {bilan.produitsPartages.length > 0 && (
            <div>
              <p className="text-warning">{bilan.produitsPartages.length} produit(s) partagé(s) par plusieurs dossiers :</p>
              <ul className="max-h-40 overflow-y-auto">
                {bilan.produitsPartages.map((p) => (
                  <li key={p.id}><Link href={`/produits/${p.id}`} className="hover:underline">{p.code}</Link> — {p.dossiers.join(", ")}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
