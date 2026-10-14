"use client";

/**
 * LA SECONDE CONFIRMATION DU BUDGET MARKETING — une fenêtre (jamais `window.confirm`) : titre, ce qui va se passer,
 * « Retour » ou le geste. Échap la ferme, elle seule (capturé avant le panneau qui est dessous). Un motif facultatif
 * peut s'y saisir. Partagée par Dépenses (imputer, consommer, annuler), la vue d'ensemble (réallouer) et les Réglages
 * (supprimer une catégorie).
 */

import * as React from "react";
import { Button } from "@/components/ui/button";

export interface Confirmation {
  titre: string;
  corps: React.ReactNode;
  bouton: string;
  danger?: boolean;
  motif?: boolean;
  ok: (motif: string) => Promise<void>;
}

export function FenetreConfirmation({ c, occupe, onFermer }: { c: Confirmation; occupe: boolean; onFermer: () => void }) {
  const [motif, setMotif] = React.useState("");
  const bouton = React.useRef<HTMLButtonElement>(null);
  const fermer = React.useRef(onFermer);
  fermer.current = onFermer;
  React.useEffect(() => {
    bouton.current?.focus();
    // Échap ferme la fenêtre — et elle seule : capturé avant le panneau qui est dessous.
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fermer.current(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  const confirmer = async () => {
    const m = motif.trim();
    onFermer();
    await c.ok(m);
  };
  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/40" onClick={onFermer} />
      <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
        <div role="alertdialog" aria-modal="true" aria-labelledby="conf-titre" aria-describedby="conf-corps" className="pointer-events-auto relative grid w-full max-w-[440px] gap-3.5 rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <h3 id="conf-titre" className="text-base font-semibold">{c.titre}</h3>
          <div id="conf-corps" className="text-sm">{c.corps}</div>
          {c.motif && (
            <div className="grid gap-1.5">
              <label htmlFor="conf-motif" className="text-xs font-semibold">Motif <span className="font-normal text-muted-foreground">(facultatif)</span></label>
              <textarea id="conf-motif" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ex. événement reporté à l'an prochain" maxLength={500} className="min-h-[70px] w-full resize-y rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] focus-ring" />
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onFermer}>Retour</Button>
            <Button ref={bouton} variant={c.danger ? "destructive" : "primary"} onClick={() => void confirmer()} disabled={occupe}>{c.bouton}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
