import { NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { dispositionFor, extensionOf } from "@/lib/files/attachment-policy";

/**
 * SERVIR UNE PIÈCE STOCKÉE — la réponse commune des routes de pièces (retours, KPI, documents RH, réunions).
 *
 * Chaque route garde SA règle d'accès (c'est elle qui dit qui a droit) ; ce qui était recopié de route en route
 * — le type ENREGISTRÉ (jamais celui annoncé par le navigateur), les en-têtes anti-exécution d'un type actif
 * (`types-actifs.ts`), le nom encodé (`filename*=UTF-8''…` : ni guillemet ni retour à la ligne ne s'échappent),
 * `?dl=1` qui force le téléchargement, aucun cache partagé — vit ici, une seule fois.
 *
 * Les options gardent le comportement de chaque route : `disposition: "selon-type"` n'affiche en ligne qu'un PDF
 * ou une image (le reste se télécharge) ; `bacASable` ajoute `nosniff` et une CSP fermée à TOUTE pièce.
 */
export function servirPiece(
  req: { nextUrl: URL },
  piece: { octets: Uint8Array; nom: string; mime: string | null | undefined },
  options: { disposition: "selon-type" | "en-ligne"; bacASable: boolean },
): NextResponse {
  const mime = piece.mime || "application/octet-stream";
  const telecharger = req.nextUrl.searchParams.get("dl") === "1";
  const disposition = telecharger ? "attachment" : options.disposition === "en-ligne" ? "inline" : dispositionFor(extensionOf(piece.nom));
  return new NextResponse(new Uint8Array(piece.octets), {
    headers: {
      "Content-Type": mime,
      ...entetesAntiExecution(mime),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(piece.nom)}`,
      "Content-Length": String(piece.octets.length),
      ...(options.bacASable ? { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } : {}),
      "Cache-Control": "private, no-store",
    },
  });
}
