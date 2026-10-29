"use client";

/**
 * LES PRATICIENS — le panneau flottant (menu, filtre) ancré à un élément, en portail.
 */
import * as React from "react";
import { createPortal } from "react-dom";

// ─────────────────────────────── Le panneau flottant ───────────────────────────────

/**
 * UN PANNEAU POSÉ SOUS SON ANCRE, hors du cadre qui défile (portail) : un menu dans un tableau à défilement serait rogné.
 * Il suit l'ancre quand le tableau défile, s'ouvre au-dessus s'il manque de place, et se ferme au clic ailleurs ou à Échap.
 */
export function Flottant({ ancre, onFermer, largeur, garderFocus, children }: { ancre: HTMLElement; onFermer: () => void; largeur: number; garderFocus?: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; left: number; maxH: number } | null>(null);
  const fermer = React.useRef(onFermer);
  fermer.current = onFermer;
  React.useLayoutEffect(() => {
    const placer = () => {
      const r = ancre.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(8, Math.min(r.left, vw - largeur - 8));
      const dessous = vh - r.bottom - 12, dessus = r.top - 12;
      setPos(dessous >= 220 || dessous >= dessus
        ? { top: r.bottom + 4, left, maxH: Math.max(140, Math.min(360, dessous)) }
        : { bottom: vh - r.top + 4, left, maxH: Math.max(140, Math.min(360, dessus)) });
    };
    placer();
    window.addEventListener("scroll", placer, true);
    window.addEventListener("resize", placer);
    return () => { window.removeEventListener("scroll", placer, true); window.removeEventListener("resize", placer); };
  }, [ancre, largeur]);
  React.useEffect(() => {
    const ailleurs = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ancre.contains(t)) return;
      fermer.current();
    };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape" && !garderFocus) fermer.current(); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    document.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("mousedown", ailleurs);
      document.removeEventListener("touchstart", ailleurs);
      document.removeEventListener("keydown", echap);
    };
  }, [ancre, garderFocus]);
  if (!pos || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: largeur, maxHeight: pos.maxH }} className="fixed z-50 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      {children}
    </div>,
    document.body,
  );
}
