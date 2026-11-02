"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationSuppression } from "@/components/shared/super-admin-delete";
import { supprimerDemandeAdPro } from "@/lib/actions/admin-delete-actions";

/**
 * « SUPPRIMER LA DEMANDE » sur une fiche Ad & Pro (§118.175) — le Super Admin, le directeur des
 * opérations, la directrice marketing. `enabled` est calculé au serveur par la même règle que
 * l'action (`peutSupprimerUneDemandeAdPro`) ; ce bouton n'est qu'une commodité, l'action revérifie.
 *
 * La fenêtre est LA fenêtre de confirmation commune : elle lit avant le clic ce qui partira avec
 * la demande et ce qui le refuserait — deux fenêtres pour le même geste diraient deux choses.
 */
export function SupprimerDemandeAdPro({ kind, id, name, enabled }: { kind: string; id: string; name: string; enabled: boolean }) {
  const router = useRouter();
  // Le rafraîchissement SUIVI (§118.172) : un écran ajouté ne rafraîchit plus « à nu ».
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  if (!enabled) return null;
  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" /> Supprimer la demande
      </Button>
      <ConfirmationSuppression
        open={open}
        onClose={() => setOpen(false)}
        kind={kind}
        id={id}
        name={name}
        executer={supprimerDemandeAdPro}
        onSupprime={(r) => {
          setOpen(false);
          router.push(r.redirect ?? "/ad-pro");
          rafraichir();
        }}
      />
    </>
  );
}
