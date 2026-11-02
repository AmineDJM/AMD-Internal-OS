"use client";

import * as React from "react";
import { Info, X } from "lucide-react";

/**
 * CE QUE LA CRÉATION A DIT, MONTRÉ SUR LA FICHE QU'ELLE OUVRE.
 *
 * Un formulaire qui crée puis ouvre la fiche (`redirectBase`) quitte l'écran avant d'avoir pu dire sa phrase — « Nouveau
 * fournisseur ajouté à l'annuaire : … » se perdait avec lui. Le formulaire la RETIENT (`retenirAnnonce`) pour la fiche
 * qu'il ouvre ; la fiche la montre UNE fois (`AnnonceDeCreation`), puis l'oublie. Stockage de session du navigateur :
 * rien ne part au serveur, rien ne survit à l'onglet ; indisponible (navigation privée stricte), la phrase se tait.
 */

const CLE = (cle: string) => `annonce-creation:${cle}`;

export function retenirAnnonce(cle: string, texte: string): void {
  try { sessionStorage.setItem(CLE(cle), texte); } catch { /* stockage indisponible : rien à retenir */ }
}

export function AnnonceDeCreation({ cle }: { cle: string }) {
  const [texte, setTexte] = React.useState<string | null>(null);
  React.useEffect(() => {
    try {
      const t = sessionStorage.getItem(CLE(cle));
      if (t) { setTexte(t); sessionStorage.removeItem(CLE(cle)); }
    } catch { /* stockage indisponible */ }
  }, [cle]);
  if (!texte) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">{texte}</p>
      <button type="button" aria-label="Fermer" onClick={() => setTexte(null)} className="text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
