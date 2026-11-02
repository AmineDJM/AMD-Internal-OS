"use client";

import * as React from "react";
import { Lock, Trash2 } from "lucide-react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { ConfirmationSuppression } from "@/components/shared/super-admin-delete";
import { apercuSuppressionPieceDeLaDemande, supprimerPieceDeLaDemande } from "@/modules/ad-pro/actions-pieces";

/**
 * « SUPPRIMER LA PIÈCE » sur la ligne d'une pièce Legal d'une demande Ad & Pro (§118.209).
 *
 * `offert` est calculé au serveur par la MÊME décision que l'action (`droitsSuppressionDesPieces`) : ce
 * bouton n'est qu'une commodité, l'action revérifie — mais un bouton offert est un geste accepté
 * (§118.83). Quand ce qui ENGAGE la pièce le refuse (signée, réglée, partie au règlement, validée par un
 * centre, base d'une autre pièce), la ligne le DIT, avec le geste qui reste : un geste qui disparaît sans
 * un mot fait chercher une panne qui n'existe pas. Sans droit sur la demande, rien n'est rendu.
 *
 * La fenêtre est LA fenêtre de confirmation commune : elle lit avant le clic ce qui partira avec la
 * pièce et ce qui le refuserait, et la confirmation est décisive (double geste). La suppression est
 * réversible — le Super Admin restaure depuis la corbeille.
 */
export function SupprimerPieceLegal({ id, nom, offert }: { id: string; nom: string; offert: boolean }) {
  // Le rafraîchissement SUIVI (§118.172) : un écran ajouté ne rafraîchit plus « à nu ».
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);

  if (!offert) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Supprimer la pièce « ${nom} »`}
        title="Supprimer la pièce (réversible — corbeille)"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground sm:h-auto sm:w-auto sm:p-1.5 transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <ConfirmationSuppression
        open={open}
        onClose={() => setOpen(false)}
        kind="LEGAL_DOCUMENT"
        id={id}
        name={nom}
        warning="Les fichiers de la pièce partent avec elle."
        executer={supprimerPieceDeLaDemande}
        apercuer={apercuSuppressionPieceDeLaDemande}
        onSupprime={() => {
          setOpen(false);
          rafraichir();
        }}
      />
    </>
  );
}

/** Pourquoi une pièce ne se supprime pas d'ici — la phrase du serveur, avec le geste qui reste. Rien sans raison. */
export function RaisonPieceNonSupprimable({ raison }: { raison: string | null }) {
  if (!raison) return null;
  return (
    <p className="mt-1 flex items-start gap-1 pl-3 text-[0.6875rem] text-muted-foreground" data-suppression-refusee>
      <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>Ne se supprime pas d&apos;ici. {raison}</span>
    </p>
  );
}
