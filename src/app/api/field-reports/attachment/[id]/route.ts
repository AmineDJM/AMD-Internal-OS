import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { userCan } from "@/lib/rbac";
import { peutOuvrirPieceDeRapport } from "@/lib/entity-access/ouverture-pieces";

export const dynamic = "force-dynamic";

/** Sert une pièce jointe de rapport — auteur du rapport ou manager. */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  // Garde sur le module RAPPORTS TERRAIN d'abord (la règle partagée le revérifie) : sans lui, inutile de charger la pièce.
  if (!user || !userCan(user, "FIELD_REPORTS", "VIEW")) return new NextResponse(null, { status: 403 });

  const att = await prisma.fieldReportAttachment.findUnique({
    where: { id: params.id },
    select: { blobId: true, name: true, mime: true, report: { select: { delegateId: true } } },
  });
  if (!att) return new NextResponse(null, { status: 404 });
  if (!peutOuvrirPieceDeRapport(user, att.report)) return new NextResponse(null, { status: 403 });

  const bytes = await getBlob(att.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });
  const dl = req.nextUrl.searchParams.get("dl") === "1";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": att.mime || "application/octet-stream",
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(att.mime || "application/octet-stream"),
      "Content-Disposition": `${dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
