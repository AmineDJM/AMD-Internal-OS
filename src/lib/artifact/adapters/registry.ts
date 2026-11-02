/**
 * LE REGISTRE DES ADAPTATEURS — un fichier, un format, une ligne.
 *
 * C'est le seul endroit du système qui sait qu'il existe quatre formats. Ajouter le cinquième
 * (ODT, CSV, images) consiste à écrire un adaptateur et à l'inscrire ici : le runtime, les
 * sessions, l'annulation, le versionnement et l'UI n'en savent rien et n'ont pas à changer.
 */

import type { ArtifactFormat } from "@/lib/artifact/object-model/model";
import type { AdaptateurArtefact } from "@/lib/artifact/adapters/contract";
import { adaptateurDocx } from "@/lib/artifact/adapters/docx/adapter";
import { adaptateurPdf } from "@/lib/artifact/adapters/pdf/adapter";
import { adaptateurXlsx } from "@/lib/artifact/adapters/xlsx/adapter";
import { adaptateurPptx } from "@/lib/artifact/adapters/pptx/adapter";

export const ADAPTATEURS: Record<ArtifactFormat, AdaptateurArtefact> = {
  DOCX: adaptateurDocx,
  XLSX: adaptateurXlsx,
  PPTX: adaptateurPptx,
  PDF: adaptateurPdf,
};

export const adaptateurPour = (f: ArtifactFormat): AdaptateurArtefact => ADAPTATEURS[f];

/**
 * DEVINE le format d'un fichier. Le NOM d'abord, le type MIME ensuite.
 *
 * L'ordre n'est pas indifférent : les navigateurs et les serveurs de courrier envoient
 * régulièrement un `.docx` déclaré `application/octet-stream`, et un `.pdf` déclaré
 * `application/x-download`. L'extension, elle, est presque toujours juste.
 */
export function formatDeFichier(nom: string, mime?: string | null): ArtifactFormat | null {
  const bas = nom.toLowerCase();
  for (const f of Object.keys(ADAPTATEURS) as ArtifactFormat[]) {
    if (ADAPTATEURS[f].extensions.some((e) => bas.endsWith(e))) return f;
  }
  if (mime) {
    const m = mime.toLowerCase().split(";")[0].trim();
    for (const f of Object.keys(ADAPTATEURS) as ArtifactFormat[]) {
      if (ADAPTATEURS[f].mimes.includes(m)) return f;
    }
  }
  return null;
}

/** Le type MIME canonique d'un format — celui qu'on écrit dans le Drive. */
export const mimeDe = (f: ArtifactFormat): string => ADAPTATEURS[f].mimes[0];
