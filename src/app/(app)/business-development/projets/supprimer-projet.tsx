"use client";

import * as React from "react";

import { Trash2 } from "lucide-react";
import { deleteBdProject } from "@/lib/actions/bd-project-actions";
import { ConfirmationSuppression } from "@/components/shared/super-admin-delete";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";

/**
 * SUPPRIMER UN PROJET depuis l'écran « Projets » (§118.163) — par la fenêtre de confirmation
 * commune, qui lit AVANT le clic ce qui part avec lui (gammes, produits) et ce qui perd son lien
 * (les dossiers réglementaires classés). La suppression passe par la corbeille : tout revient
 * ensemble si le Super Admin la restaure. Une seule fenêtre pour ce geste, parce que deux
 * rédactions de « ce qui part » finiraient par dire deux choses (§118.5).
 */
export function SupprimerProjet({ id, name }: { id: string; name: string }) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" /> Supprimer
      </Button>
      <ConfirmationSuppression
        open={open}
        onClose={() => setOpen(false)}
        kind="BD_PROJECT"
        id={id}
        name={name}
        executer={deleteBdProject}
        onSupprime={() => { setOpen(false); rafraichir(); }}
      />
    </>
  );
}
