"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AvisRetour } from "./retour-regle";
import { STYLE } from "./retour-style";

/** Le dessin des avis flottants — chargé après la page par `retours-porteur.tsx`. */
export function Avis({ lot, retirer }: { lot: AvisRetour[]; retirer: (id: number) => void }) {
  return lot.map((a) => {
    const { classe, Icone } = STYLE[a.ton];
    return (
      <div key={a.id} className={cn("pointer-events-auto flex items-start gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm shadow-lg animate-slide-up", classe)}>
        <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 whitespace-pre-line break-words">{a.message}</p>
        <button type="button" onClick={() => retirer(a.id)} className="-m-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer le message">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  });
}
