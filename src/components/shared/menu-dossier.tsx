"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";

/**
 * « ⋯ » — LES GESTES SECONDAIRES D'UNE FICHE (Direction, 07/10 : « un geste principal visible, le reste dans ⋯ »).
 *
 * Les boutons arrivent tout faits du serveur (corriger la demande, la transférer, la supprimer…) : ce menu ne décide
 * d'aucun droit, il les range. Ils restent montés tant que le menu est ouvert — leur fenêtre (Sheet) vit dans ce bloc,
 * si bien qu'un clic dans la fenêtre n'est pas un « clic ailleurs » qui la refermerait. Même menu que celui de la
 * fiche du matériel promotionnel (`promo-material/[id]/menu-dossier.tsx`).
 */
export function MenuDossier({ children, label = "Autres actions", doigt = false }: {
  children: React.ReactNode;
  /** Le nom du bouton pour un lecteur d'écran (« Autres actions sur ce rappel »). */
  label?: string;
  /** 40 px au téléphone (une liste où le menu côtoie des boutons de 40 px). */
  doigt?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const ailleurs = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    document.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("mousedown", ailleurs);
      document.removeEventListener("touchstart", ailleurs);
      document.removeEventListener("keydown", echap);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className={`flex ${doigt ? "h-10 w-10" : "h-9 w-9"} items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:h-8 sm:w-8`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-50 mt-1 flex w-64 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-1.5 rounded-lg border border-border bg-background p-2 shadow-lg sm:left-auto sm:right-0">
          {children}
        </div>
      )}
    </div>
  );
}
