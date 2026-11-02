"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { SELECTEUR_FOCUSABLE, sautDeFocus } from "./sheet-focus-regle";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: "md" | "lg" | "xl";
}

/**
 * Panneau latéral de création / édition.
 *
 * Sur ORDINATEUR : il glisse depuis la droite, sur toute la hauteur.
 * Sur TÉLÉPHONE : c'est une **feuille qui monte du bas**, arrondie en haut, avec une poignée —
 * la gestuelle attendue d'une application mobile. Elle ne prend pas tout l'écran (95 % au plus)
 * pour qu'on voie ce qu'il y a derrière et qu'on comprenne qu'un simple appui à côté referme.
 */
export function Sheet({ open, onClose, title, description, children, footer, width = "md" }: SheetProps) {
  // Le défilement de l'arrière-plan est figé pendant l'ouverture. Le verrou est COMPTÉ : une
  // feuille ouverte depuis un tiroir ne rend pas le défilement au tiroir en se refermant.
  useScrollLock(open);

  React.useEffect(() => {
    if (!open) return;
    // Un bouton décisif armé consomme Échap (il se désarme, le panneau reste).
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // LE FOCUS ENTRE DANS LA FEUILLE ET Y RESTE, puis revient d'où il venait (audit 27/10/2026,
  // FRONTEND-UX-02) : `aria-modal` promet que tout se passe ici. Le premier champ reçoit le focus
  // (à défaut, le panneau lui-même) ; Tab boucle à l'intérieur (`sheet-focus-regle.ts`) ; à la
  // fermeture, le bouton qui l'avait ouverte le retrouve — sinon il tombe sur `<body>`.
  const panneau = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const avant = document.activeElement as HTMLElement | null;
    const racine = panneau.current;
    if (racine && !racine.contains(document.activeElement)) {
      // Au doigt, on ne pose PAS le focus dans un champ : le clavier virtuel monterait aussitôt et
      // couvrirait la moitié de la feuille. Le panneau prend le focus, la saisie attend un appui.
      const tactile = window.matchMedia?.("(pointer: coarse)").matches;
      const champ = tactile ? null : racine.querySelector<HTMLElement>("[autofocus], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])");
      (champ ?? racine).focus({ preventScroll: true });
    }
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || !panneau.current) return;
      // Une couche modale ouverte PAR-DESSUS (une autre feuille, un sélecteur) garde son propre focus.
      const modale = (document.activeElement as HTMLElement | null)?.closest('[aria-modal="true"]');
      if (modale && modale !== panneau.current) return;
      const cibles = Array.from(panneau.current.querySelectorAll<HTMLElement>(SELECTEUR_FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      const saut = sautDeFocus(cibles.length, cibles.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (saut === null) return;
      e.preventDefault();
      cibles[saut].focus();
    };
    document.addEventListener("keydown", onTab);
    return () => {
      document.removeEventListener("keydown", onTab);
      if (avant && avant.isConnected && typeof avant.focus === "function") avant.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex max-h-[95dvh] flex-col overflow-hidden rounded-t-2xl bg-card shadow-2xl outline-none animate-slide-up",
          "sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-full sm:rounded-none sm:animate-slide-in",
          width === "xl" ? "sm:max-w-4xl" : width === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
        ref={panneau}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Poignée : signale que la feuille se referme, et donne une zone de préhension. */}
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="flex items-start justify-between border-b border-border px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold sm:text-lg">{title}</h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary"
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5">{children}</div>
        {footer && <div className="border-t border-border px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5">{footer}</div>}
      </div>
    </div>
  );
}
