"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { roleDuRetour, type TonRetour } from "./retour-regle";
import { STYLE } from "./retour-style";

export { useRetours } from "./retours-porteur";

/**
 * LE RETOUR D'UN GESTE — bandeau dans l'écran, ou avis flottant (V3-B). Remplace `window.alert()`.
 *
 * ── COMMENT S'EN SERVIR ─────────────────────────────────────────────────────────────────────
 *
 *     // À CÔTÉ DU GESTE (l'erreur d'un formulaire, d'un panneau) — le cas par défaut :
 *     <Retour ton="erreur">{err}</Retour>            // rien n'est rendu si `err` est vide
 *
 *     // QUAND LE GESTE N'A PAS DE PLACE POUR PARLER (une icône dans une ligne, un menu) :
 *     const retours = useRetours();
 *     retours.erreur(r.error ?? "La suppression n'a pas abouti.");
 *     retours.succes("Lien copié.");
 *
 * La règle (rôle ARIA, durée, pile) vit dans `retour-regle.ts`, pure et testée : une ERREUR est
 * annoncée tout de suite (`role="alert"`) et ne s'efface jamais seule ; un succès est annoncé poliment
 * (`role="status"`) et part après le temps de le lire.
 *
 * Écrire le message : dire CE QUI s'est passé et CE QU'ON PEUT FAIRE (« Le document n'a pas été
 * supprimé : il est rattaché à un dossier ouvert. »), jamais « Échec. » — et, pour une panne de
 * connexion, `actionFailureMessage()` (`lib/action-outcome.ts`), qui n'invite pas à réessayer.
 */

/** Le bandeau, posé dans l'écran à côté du geste qui l'a produit. */
export function Retour({
  ton = "erreur",
  children,
  onFermer,
  className,
}: {
  ton?: TonRetour;
  children?: React.ReactNode;
  /** Affiche une croix « Fermer ». */
  onFermer?: () => void;
  className?: string;
}) {
  if (children === null || children === undefined || children === false || children === "") return null;
  const { classe, Icone } = STYLE[ton];
  return (
    <div role={roleDuRetour(ton)} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", classe, className)}>
      <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 whitespace-pre-line break-words">{children}</div>
      {onFermer && (
        <button type="button" onClick={onFermer} className="-m-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer le message">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
