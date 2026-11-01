import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/http/content-disposition";
import type { ResultatExport } from "./types";

/**
 * LA RÉPONSE D'UNE ROUTE D'EXPORT (lot K7, décision 0037) — le fichier en pièce téléchargée, ou le refus avec le
 * statut de la fonction d'export. La route ne décide plus rien : elle lit ses paramètres et appelle la fonction.
 */
export function reponseExport(r: ResultatExport, mode: "attachment" | "inline" = "attachment"): NextResponse {
  if (!r.ok) return NextResponse.json({ error: r.erreur }, { status: r.statut });
  return new NextResponse(r.fichier.octets as unknown as BodyInit, {
    headers: {
      "Content-Type": r.fichier.mime,
      "Content-Disposition": contentDisposition(r.fichier.nomDeFichier, mode),
      "Cache-Control": "private, no-store",
    },
  });
}
