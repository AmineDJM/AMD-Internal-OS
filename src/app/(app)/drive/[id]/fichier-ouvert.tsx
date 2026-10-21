"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { natureApercu } from "@/lib/formats/apercu";
import { BackLink } from "@/components/shared/back-link";
import { FileGlyph } from "@/components/drive/file-glyph";
import type { SessionPrete } from "@/components/documents/editeur-en-ligne";
import { NodeActions } from "../node-actions";
import { FileViewer } from "./file-viewer";

/**
 * LE FICHIER OUVERT — on clique sur le nom dans la liste, on est DEDANS (Direction, 10/2026 : « comme Google Drive »).
 *
 * Plus de page intermédiaire avec ses boutons et son panneau d'informations : une barre fine (retour, nom, puis
 * les trois icônes Partage · Commentaires · ⋯, les mêmes que dans la liste) et le fichier sur toute la hauteur.
 * Word, Excel, PowerPoint s'ouvrent dans l'éditeur Office — en édition si l'on a le droit, en lecture sinon ; un
 * PDF, une image, un texte, dans leur aperçu.
 */
export function FichierOuvert({
  id, name, retour, canEdit, owner, infos, counts, convertible, session, champs,
}: {
  id: string;
  name: string;
  /** Le dossier du fichier : retour, et destination après la corbeille. */
  retour: string;
  canEdit: boolean;
  owner: string;
  infos: { sizeLabel: string; typeLabel: string; updatedLabel: string };
  counts: { shares: number; comments: number; versions: number };
  convertible: boolean;
  session?: SessionPrete;
  champs?: React.ReactNode;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [pleinEcran, setPleinEcran] = React.useState(false);
  const nature = natureApercu(name);
  // Ce qui s'affiche sur toute la hauteur (éditeur Office, PDF) ; le reste défile dans une marge.
  const pleineHauteur = nature === "docx" || nature === "xlsx" || nature === "pptx" || nature === "converti" || nature === "pdf";

  // Synchronise l'état avec le plein écran natif (Échap, F11…).
  React.useEffect(() => {
    const onChange = () => setPleinEcran(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const basculer = React.useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else wrapRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  return (
    // Hors plein écran, le fichier occupe la zone de contenu mesurée : sur téléphone, la barre
    // d'outils basse de l'éditeur passait sinon derrière la barre d'onglets.
    <div ref={wrapRef} className={cn("flex flex-col overflow-hidden rounded-lg border border-border bg-background", pleinEcran ? "h-[100dvh] rounded-none border-0" : "app-viewport")}>
      <div className="flex items-center gap-1.5 border-b border-border bg-card px-1.5 py-1 sm:gap-2 sm:px-2">
        <BackLink href={retour} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-8">
          <ArrowLeft className="h-4 w-4" /> <span className="sr-only sm:not-sr-only">Drive</span>
        </BackLink>
        <div className="flex min-w-0 flex-1 items-center gap-2" data-fichier-ouvert={id}>
          <FileGlyph name={name} isFile />
          <h1 className="min-w-0 truncate text-sm font-semibold" title={name}>{name}</h1>
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{infos.updatedLabel}</span>
        </div>
        <NodeActions
          id={id} name={name} isFile canEdit={canEdit} owner={owner}
          infos={infos} counts={counts} convertible={convertible}
          ouvert={{ retour, pleinEcran: { actif: pleinEcran, basculer }, champs }}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0", pleineHauteur ? "" : "overflow-auto p-2 sm:p-4")}>
          <FileViewer id={id} name={name} session={session} plein={pleineHauteur} />
        </div>
      </div>
    </div>
  );
}
