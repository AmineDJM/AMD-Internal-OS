"use client";

import * as React from "react";
import { Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { rattacherDossierCanonique } from "@/lib/actions/produit-canonique-actions";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * CRÉER LA FICHE PRODUIT D'UN DOSSIER — le filet d'un dossier d'avant ce lot dont le produit n'existe pas encore
 * (chaque dossier en reçoit un à son enregistrement, et l'existant au démarrage du serveur). Le résultat se DIT
 * (« Produit PRD-2026-012 créé ») : un bouton qui se contente de disparaître laisserait deviner ce qu'il a fait.
 */
export function CreerProduitBouton({ dossierId }: { dossierId: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [envoi, setEnvoi] = React.useState(false);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);

  async function creer() {
    setEnvoi(true); setRetour(null);
    const fd = new FormData();
    fd.set("id", dossierId);
    try {
      const r = await rattacherDossierCanonique(fd);
      setRetour({ ok: r.ok, texte: r.ok ? r.message ?? "Fiche produit créée." : r.error ?? "Création impossible." });
      if (r.ok) rafraichir();
    } catch {
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }

  const occupe = envoi || enCours;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={occupe} onClick={creer}>
        {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />}
        Créer sa fiche produit
      </Button>
      {retour && (
        <span role={retour.ok ? "status" : "alert"} className={retour.ok ? "text-xs text-success" : "text-xs text-destructive"}>
          {retour.texte}
        </span>
      )}
    </span>
  );
}
