"use client";

import React, { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { Download, ExternalLink, Loader2, PenLine, X } from "lucide-react";
import { modifiable } from "../domaine/lecture/depot";
import { IconePiece, type PieceOuvrable } from "./pieces-jointes";

// L'aperçu (visionneuses Word, Excel, PowerPoint) ne se charge qu'à la première ouverture : la page
// de l'assistant ne le paie pas tant qu'on n'ouvre rien.
const ApercuUniversel = dynamic(() => import("@/components/documents/apercu-universel").then((m) => m.ApercuUniversel), {
  ssr: false,
  loading: () => <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</div>,
});

/**
 * L'APERÇU D'UNE PIÈCE DE LA CONVERSATION (décision 0015) — un panneau latéral, en LECTURE : PDF,
 * images, vidéo, son tels que le navigateur les lit ; Word, Excel, PowerPoint par les visionneuses
 * de l'aperçu universel (sans éditeur : on n'édite pas ici) ; le reste se télécharge. Les octets
 * viennent de `/api/drive/<id>/raw` — droits revérifiés à chaque lecture.
 *
 * « Télécharger », « Ouvrir dans le Drive » et, sur un Word (ou une présentation), « Demander une
 * modification » — qui pré-remplit la saisie, la pièce jointe. Échap ferme ; le focus revient où il était.
 */
export function ApercuPiece({ piece, onFermer, onDemanderModification }: {
  piece: PieceOuvrable | null;
  onFermer: () => void;
  onDemanderModification?: (p: PieceOuvrable) => void;
}) {
  const fermer = useRef<HTMLButtonElement>(null);
  const avant = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!piece) return;
    avant.current = document.activeElement as HTMLElement | null;
    fermer.current?.focus();
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onFermer(); } };
    document.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("keydown", echap);
      avant.current?.focus?.();
    };
  }, [piece, onFermer]);
  if (!piece) return null;
  const src = `/api/drive/${piece.id}/raw`;
  const peutModifier = modifiable(piece.nom);
  const bouton = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[1px] lg:bg-slate-950/20" onClick={onFermer} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Aperçu de ${piece.nom}`}
        data-testid="apercu-piece"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <header className="flex items-start gap-2 border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
          <IconePiece nom={piece.nom} className="mt-0.5 h-4 w-4" />
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-100">{piece.nom}</h2>
          <button ref={fermer} type="button" onClick={onFermer} aria-label="Fermer l'aperçu (Échap)" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-zinc-400 dark:hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-2 dark:border-zinc-800">
          <a href={`${src}?dl=1`} className={bouton} download><Download className="h-3.5 w-3.5" /> Télécharger</a>
          <a href={`/drive/${piece.id}`} target="_blank" rel="noopener" className={bouton}><ExternalLink className="h-3.5 w-3.5" /> Ouvrir dans le Drive</a>
          {peutModifier && onDemanderModification && (
            <button type="button" onClick={() => onDemanderModification(piece)} className={`${bouton} border-violet-300 text-violet-800 dark:border-violet-800 dark:text-violet-200`}>
              <PenLine className="h-3.5 w-3.5" /> Demander une modification
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <ApercuUniversel src={src} name={piece.nom} telechargement={`${src}?dl=1`} />
        </div>
      </aside>
    </>
  );
}
