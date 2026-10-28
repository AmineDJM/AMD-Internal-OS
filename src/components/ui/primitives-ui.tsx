"use client";

import * as React from "react";
import { DialoguesProvider } from "./dialogue";
import { RetoursProvider } from "./retours-porteur";

/**
 * LES PORTEURS DES PRIMITIVES UI — montés UNE fois, dans `app/(app)/layout.tsx` (et le portail
 * fournisseur), autour de toute l'application — pas à la racine : c'est une autre entrée de build, qui
 * aurait recopié ces modules une seconde fois dans le JS de chaque page. Hors de ces deux coques
 * (connexion, impression…), les crochets retombent sur la boîte du navigateur.
 *
 * `useConfirmer()` / `useSaisir()` (`dialogue.tsx`) et `useRetours()` (`retours-porteur.tsx`) s'appellent de
 * n'importe quel îlot client : la fenêtre et la pile d'avis vivent ici, une seule fois, au-dessus de
 * toutes les couches (dialogue `z-[100]`, avis `z-[110]` — au-dessus de la visionneuse plein écran).
 */
export function PrimitivesUI({ children }: { children: React.ReactNode }) {
  return (
    <RetoursProvider>
      <DialoguesProvider>{children}</DialoguesProvider>
    </RetoursProvider>
  );
}
