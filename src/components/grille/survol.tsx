"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * LE PANNEAU QUI S'OUVRE SOUS UN BOUTON D'EN-TÊTE — filtre d'une colonne, choix des colonnes.
 *
 * Il est rendu dans `document.body`, en position FIXE calée sur son bouton : posé dans la table,
 * il serait coupé par le cadre qui la fait défiler (`overflow-auto`) — le menu d'un filtre
 * s'arrêterait à la troisième valeur. Il suit son bouton quand la page ou la feuille défilent.
 *
 * Échap ferme et rend la main au bouton ; un clic ailleurs ferme sans voler le focus de ce qu'on
 * vient de cliquer. À l'ouverture, le focus va au premier champ marqué `data-autofocus`.
 */
export function Survol({ ancre, onFermer, etiquette, largeur = 288, children, className }: {
  ancre: React.RefObject<HTMLElement | null>;
  onFermer: () => void;
  /** Le nom du panneau pour un lecteur d'écran. */
  etiquette: string;
  largeur?: number;
  children: React.ReactNode;
  className?: string;
}) {
  const panneau = React.useRef<HTMLDivElement>(null);
  // La place est calculée DÈS le premier rendu (le bouton est déjà là) : un panneau d'abord caché
  // ne pourrait pas recevoir le focus que l'effet d'ouverture lui donne.
  const [pos, setPos] = React.useState<React.CSSProperties>(() => position(ancre.current, largeur));
  const rendreLeFocus = React.useRef(true);
  const fermer = React.useRef(onFermer);
  React.useLayoutEffect(() => { fermer.current = onFermer; }, [onFermer]);

  const placer = React.useCallback(() => setPos(position(ancre.current, largeur)), [ancre, largeur]);

  React.useEffect(() => {
    const bouton = ancre.current;
    const premier = panneau.current?.querySelector<HTMLElement>("[data-autofocus]")
      ?? panneau.current?.querySelector<HTMLElement>("input, button");
    premier?.focus({ preventScroll: true });
    const dehors = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panneau.current?.contains(t) || bouton?.contains(t)) return;
      rendreLeFocus.current = false;
      fermer.current();
    };
    const echap = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      fermer.current();
    };
    // Un défilement DANS le panneau (sa liste de valeurs) ne le déplace pas ; celui de la page, si.
    const defile = (e: Event) => { if (!panneau.current?.contains(e.target as Node)) placer(); };
    document.addEventListener("mousedown", dehors);
    document.addEventListener("touchstart", dehors);
    document.addEventListener("keydown", echap, true);
    window.addEventListener("resize", placer);
    window.addEventListener("scroll", defile, true);
    return () => {
      document.removeEventListener("mousedown", dehors);
      document.removeEventListener("touchstart", dehors);
      document.removeEventListener("keydown", echap, true);
      window.removeEventListener("resize", placer);
      window.removeEventListener("scroll", defile, true);
      if (rendreLeFocus.current) bouton?.focus({ preventScroll: true });
    };
  }, [ancre, placer]);

  return createPortal(
    <div
      ref={panneau} role="dialog" aria-label={etiquette} style={pos}
      className={cn("z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-sm text-foreground shadow-xl", className)}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Sous le bouton, calé sur son bord droit — au-dessus quand la place manque en bas ; jamais hors de l'écran. */
function position(bouton: HTMLElement | null, largeur: number): React.CSSProperties {
  const a = bouton?.getBoundingClientRect();
  if (!a) return { position: "fixed", visibility: "hidden" };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(largeur, vw - 16);
  const left = Math.min(Math.max(8, a.right - w), vw - w - 8);
  const dessous = vh - a.bottom - 8;
  const dessus = a.top - 8;
  return dessous >= 260 || dessous >= dessus
    ? { position: "fixed", left, width: w, top: a.bottom + 4, maxHeight: Math.max(160, dessous - 4) }
    : { position: "fixed", left, width: w, bottom: vh - a.top + 4, maxHeight: Math.max(160, dessus - 4) };
}
