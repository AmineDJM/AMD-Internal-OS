"use client";

import * as React from "react";
import { DialoguesProvider } from "./dialogue";
import { RetoursProvider } from "./retours-porteur";
import { EVENEMENT_ANNULABLE, type AnnulableVu } from "@/components/gestes/annulable-signal";

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
      <PorteurAnnulable />
    </RetoursProvider>
  );
}

type ModuleAnnulable = typeof import("@/components/gestes/annuler-geste");

/**
 * K10c — « ANNULER » APRÈS UNE ACTION RÉVERSIBLE : rien n'est chargé tant qu'aucune action n'a rendu `annulable`
 * (`use-action.ts` lance le signal) ; au premier, le bandeau se télécharge et s'affiche.
 */
function PorteurAnnulable() {
  const [etat, setEtat] = React.useState<{ m: ModuleAnnulable; premier: AnnulableVu } | null>(null);
  React.useEffect(() => {
    const ecouter = (e: Event) => {
      const premier = (e as CustomEvent<AnnulableVu>).detail;
      void import("@/components/gestes/annuler-geste").then((m) => setEtat((x) => x ?? { m, premier }));
    };
    window.addEventListener(EVENEMENT_ANNULABLE, ecouter);
    return () => window.removeEventListener(EVENEMENT_ANNULABLE, ecouter);
  }, []);
  if (!etat) return null;
  const { BandeauAnnulable } = etat.m;
  return <BandeauAnnulable premier={etat.premier} />;
}
