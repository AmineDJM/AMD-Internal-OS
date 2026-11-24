"use client";

import * as React from "react";

/** Le lien-bouton d'un geste qui vit ailleurs sur la fiche — le bouton plein de la carte « À vous ». */
const CLASSE_BOUTON_PRINCIPAL =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-ring sm:h-8";

/**
 * LE BOUTON DE LA CARTE « À VOUS » QUAND LE GESTE VIT SUR UN POSTE (24/11/2026) : il pose l'ancre du poste (`#poste-…`) et
 * le tableau des postes, qui écoute l'adresse, déplie la carte du poste et y mène. Le geste lui-même reste celui de la
 * carte — rien n'est recopié. Un second clic re-déplie un poste refermé entre-temps (l'adresse n'a pas changé : on le dit).
 */
export function BoutonVersAncre({ ancre, children }: { ancre: string; children: React.ReactNode }) {
  return (
    <a
      href={`#${ancre}`}
      className={CLASSE_BOUTON_PRINCIPAL}
      onClick={(e) => {
        e.preventDefault();
        window.history.replaceState(null, "", `#${ancre}`);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        document.getElementById(ancre)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      {children}
    </a>
  );
}
