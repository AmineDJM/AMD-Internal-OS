import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { dispositionFor, extensionOf } from "@/lib/files/attachment-policy";
import { faitsKpi } from "@/lib/kpi/service";
import { peutVoirBilan } from "@/lib/kpi/droits";

export const dynamic = "force-dynamic";

/**
 * SERT la pièce d'une déclaration de KPI — à la personne qui l'a déclarée et à qui encadre son arbre (la même règle
 * que le bilan, `peutVoirBilan`). Introuvable et interdit rendent le même 404. Type enregistré, `nosniff`, PDF et
 * images en ligne, le reste en téléchargement — les protections de la pièce d'un retour.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const d = await prisma.kpiDeclaration.findUnique({ where: { id: params.id }, select: { userId: true, pieceBlobId: true, pieceNom: true, pieceMime: true } });
  if (!d?.pieceBlobId) return new NextResponse(null, { status: 404 });
  const { faits } = await faitsKpi(user);
  if (!peutVoirBilan(faits, d.userId)) return new NextResponse(null, { status: 404 });
  const bytes = await getBlob(d.pieceBlobId);
  if (!bytes) return new NextResponse(null, { status: 404 });
  const nom = d.pieceNom ?? "piece";
  const disposition = req.nextUrl.searchParams.get("dl") === "1" ? "attachment" : dispositionFor(extensionOf(nom));
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": d.pieceMime || "application/octet-stream",
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(d.pieceMime || "application/octet-stream"),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(nom)}`,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
