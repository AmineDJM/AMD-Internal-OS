"use client";

import { ZipViewer } from "@/components/documents/zip-viewer";
import { ApercuUniversel } from "@/components/documents/apercu-universel";
import type { SessionPrete } from "@/components/documents/editeur-en-ligne";
import { extensionDe } from "@/lib/formats/apercu";

/**
 * La visionneuse d'un fichier du Drive. Le choix de l'aperçu ne se fait plus ici : il vient de la table unique
 * `formats/apercu.ts`, partagée avec la fenêtre des documents. Word, Excel, PowerPoint et leurs anciens formats
 * (.doc, .rtf, .ppt, .xls, .odt…) s'ouvrent dans l'éditeur Office, modifiables sur place ; le texte se lit et se
 * modifie ; un fichier sans aperçu possible dit pourquoi et propose le téléchargement (jamais une page blanche).
 *
 * `session` : la configuration de l'éditeur préparée par la page (aucun aller-retour après l'affichage) ;
 * `plein` : le fichier occupe toute la hauteur (fichier ouvert du Drive).
 */
export function FileViewer({ id, name, session, plein }: { id: string; name: string; kind?: string; session?: SessionPrete; plein?: boolean }) {
  const src = `/api/drive/${id}/raw`;
  // Archive ZIP → visionneuse dédiée (naviguer + visualiser l'intérieur sans décompresser).
  if (extensionDe(name) === "zip") return <ZipViewer id={id} name={name} />;
  return <ApercuUniversel src={src} name={name} telechargement={`${src}?dl=1`} cible={{ type: "drive", id }} session={session} plein={plein} />;
}
