import { NextRequest, NextResponse } from "next/server";
import { servirPiece } from "@/lib/http/servir-piece";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { faitsKpi } from "@/lib/kpi/service";
import { peutVoirBilan } from "@/lib/kpi/droits";

export const dynamic = "force-dynamic";

/**
 * SERT la pièce d'une déclaration de KPI — à la personne qui l'a déclarée et à qui encadre son arbre (la même règle
 * que le bilan, `peutVoirBilan`). Introuvable et interdit rendent le même 404. Type enregistré, `nosniff`, PDF et
 * images en ligne, le reste en téléchargement — les protections de la pièce d'un retour.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const d = await prisma.kpiDeclaration.findUnique({ where: { id: params.id }, select: { userId: true, pieceBlobId: true, pieceNom: true, pieceMime: true } });
  if (!d?.pieceBlobId) return new NextResponse(null, { status: 404 });
  const { faits } = await faitsKpi(user);
  if (!peutVoirBilan(faits, d.userId)) return new NextResponse(null, { status: 404 });
  const bytes = await getBlob(d.pieceBlobId);
  if (!bytes) return new NextResponse(null, { status: 404 });
  return servirPiece(req, { octets: bytes, nom: d.pieceNom ?? "piece", mime: d.pieceMime }, { disposition: "selon-type", bacASable: true });
}
