"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { ApercuUniversel } from "./apercu-universel";

/**
 * LA VISIONNEUSE EN SURIMPRESSION — ouvrir une pièce, la regarder, la refermer, sans quitter l'écran
 * où l'on était (Direction, 14/10 : « je dois juste pouvoir ouvrir et fermer l'image »).
 *
 *   • une IMAGE s'affiche ajustée à l'écran sur un fond assombri ; ←/→ (ou un glissé latéral au
 *     doigt) passent d'une image à l'autre quand il y en a plusieurs ;
 *   • tout autre fichier (PDF, Word, Excel, PowerPoint, texte, vidéo…) s'ouvre dans l'APERÇU
 *     UNIVERSEL, dans le même panneau — une seule table des formats pour toute l'application.
 *
 * Fermer : ✕, Échap, un clic hors de l'image, ou un glissé vers le bas au téléphone. Le geste
 * principal est voir/fermer ; « Télécharger » et « Ouvrir dans le Drive » restent discrets.
 *
 * Accessibilité : `role="dialog"` + `aria-modal`, focus posé sur « Fermer » à l'ouverture, PIÉGÉ
 * dans la visionneuse (Tab / Maj+Tab bouclent), rendu à l'élément d'origine à la fermeture.
 * Rendue dans un portail : la bulle d'un message ne peut ni la rogner ni la passer dessous.
 */

export interface PieceVisionnee {
  /** Identifiant stable (clé React). */
  id: string;
  nom: string;
  mime?: string | null;
  /** Vrai : visionneuse d'image. Faux : aperçu universel. */
  image: boolean;
  /** La route qui sert le contenu — c'est ELLE qui contrôle l'accès. */
  src: string;
  /** L'adresse de téléchargement de l'original. */
  telechargement: string;
  /** Lien secondaire vers la page du fichier dans le Drive (référence au Drive seulement). */
  lienDrive?: string | null;
  /** Pour l'aperçu universel : ouvrir dans l'éditeur Office / de texte du Drive ou des documents. */
  cible?: { type: "drive" | "document"; id: string };
}

const FOCUSABLES = 'a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex="-1"])';

export function Visionneuse({
  pieces, index, onIndex, onClose,
}: {
  pieces: readonly PieceVisionnee[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const piece = pieces[index];
  const total = pieces.length;
  const naviguer = total > 1;
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const fermerRef = React.useRef<HTMLButtonElement>(null);
  const [monte, setMonte] = React.useState(false);
  const [enEchec, setEnEchec] = React.useState<string | null>(null);

  useScrollLock(true);
  React.useEffect(() => setMonte(true), []);

  // Les rappels changent à chaque rendu du parent : on lit toujours les derniers sans réabonner.
  const rappels = React.useRef({ onClose, onIndex, index, total });
  rappels.current = { onClose, onIndex, index, total };

  const precedente = React.useCallback(() => {
    const r = rappels.current;
    if (r.total > 1) r.onIndex((r.index - 1 + r.total) % r.total);
  }, []);
  const suivante = React.useCallback(() => {
    const r = rappels.current;
    if (r.total > 1) r.onIndex((r.index + 1) % r.total);
  }, []);

  // Focus : posé sur « Fermer » à l'ouverture, rendu à l'élément d'origine à la fermeture.
  React.useEffect(() => {
    if (!monte) return;
    const avant = document.activeElement as HTMLElement | null;
    fermerRef.current?.focus();
    return () => { avant?.focus?.({ preventScroll: true }); };
  }, [monte]);

  React.useEffect(() => {
    // Échap en CAPTURE sur la fenêtre : la visionneuse est la couche du dessus, elle le consomme
    // seule (un appel en cours, un menu derrière ne doivent pas réagir au même appui).
    const echap = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      rappels.current.onClose();
    };
    const touches = (e: KeyboardEvent) => {
      const racine = dialogRef.current;
      if (!racine) return;
      if (e.key === "Tab") {
        const elements = [...racine.querySelectorAll<HTMLElement>(FOCUSABLES)].filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (elements.length === 0) { e.preventDefault(); return; }
        const premier = elements[0];
        const dernier = elements[elements.length - 1];
        const actif = document.activeElement as HTMLElement | null;
        if (!actif || !racine.contains(actif)) { e.preventDefault(); premier.focus(); }
        else if (e.shiftKey && actif === premier) { e.preventDefault(); dernier.focus(); }
        else if (!e.shiftKey && actif === dernier) { e.preventDefault(); premier.focus(); }
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const cibleSaisie = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (cibleSaisie) return;
      e.preventDefault();
      if (e.key === "ArrowLeft") precedente(); else suivante();
    };
    window.addEventListener("keydown", echap, true);
    document.addEventListener("keydown", touches);
    return () => {
      window.removeEventListener("keydown", echap, true);
      document.removeEventListener("keydown", touches);
    };
  }, [precedente, suivante]);

  React.useEffect(() => setEnEchec(null), [piece?.id]);

  // Au doigt : glisser vers le bas ferme, glisser de côté change d'image (images seulement : un
  // document se fait défiler, le geste lui appartient).
  const depart = React.useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (!piece?.image || e.touches.length !== 1) { depart.current = null; return; }
    depart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const d = depart.current;
    depart.current = null;
    if (!d || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - d.x;
    const dy = e.changedTouches[0].clientY - d.y;
    if (dy > 90 && Math.abs(dx) < 70) onClose();
    else if (naviguer && Math.abs(dx) > 60 && Math.abs(dy) < 60) (dx < 0 ? suivante : precedente)();
  };

  if (!monte || !piece) return null;

  const fermerSiFond = (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose(); };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Aperçu : ${piece.nom}`}
      className="fixed inset-0 z-[90] flex flex-col bg-black/85 text-white animate-fade-in"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Barre du haut : le nom, puis les gestes secondaires, et « Fermer » au bout, bien visible. */}
      <div
        className="flex items-center gap-1 px-2 pb-1 pt-[calc(0.5rem+env(safe-area-inset-top))] sm:gap-2 sm:px-4 sm:pt-3"
        onClick={fermerSiFond}
      >
        <div className="min-w-0 flex-1 px-1" onClick={fermerSiFond}>
          <p className="truncate text-sm font-medium">{piece.nom}</p>
          {naviguer && <p className="text-xs text-white/60 tabular-nums">{index + 1} / {total}</p>}
        </div>
        {piece.lienDrive && (
          <a
            href={piece.lienDrive}
            title="Ouvrir dans le Drive"
            aria-label="Ouvrir dans le Drive"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
          >
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">Ouvrir dans le Drive</span>
          </a>
        )}
        <a
          href={piece.telechargement}
          download={piece.nom}
          title="Télécharger"
          aria-label="Télécharger"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">Télécharger</span>
        </a>
        <button
          ref={fermerRef}
          type="button"
          onClick={onClose}
          title="Fermer (Échap)"
          aria-label="Fermer"
          className="shrink-0 rounded-full p-2.5 text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      {/* La scène : un clic hors de l'image (ou du panneau) referme. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:px-16 sm:pb-6"
        onClick={fermerSiFond}
      >
        {piece.image ? (
          enEchec ? (
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl bg-white/10 p-6 text-center text-sm">
              <ImageOff className="h-8 w-8 text-white/70" />
              <p>{enEchec}</p>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={piece.id}
              src={piece.src}
              alt={piece.nom}
              draggable={false}
              onError={() => setEnEchec("L'image ne s'affiche pas : elle a peut-être été retirée du Drive, ou votre accès a changé.")}
              className="max-h-[calc(100dvh-6rem)] max-w-full select-none rounded-md object-contain shadow-2xl sm:max-h-[calc(100dvh-7rem)]"
            />
          )
        ) : (
          <div className="max-h-full w-full max-w-5xl overflow-auto rounded-xl bg-card p-2 text-foreground shadow-2xl sm:p-3">
            <ApercuUniversel key={piece.id} src={piece.src} name={piece.nom} mime={piece.mime} telechargement={piece.telechargement} cible={piece.cible} />
          </div>
        )}

        {naviguer && (
          <>
            <button
              type="button"
              onClick={precedente}
              aria-label="Image précédente"
              title="Précédente (←)"
              className={cn(navClasse, "left-1 sm:left-4")}
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={suivante}
              aria-label="Image suivante"
              title="Suivante (→)"
              className={cn(navClasse, "right-1 sm:right-4")}
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

const navClasse = "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2.5 text-white hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";
