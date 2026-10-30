import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { peutOuvrirPieceDeSujet } from "@/lib/entity-access/ouverture-pieces";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";

export const dynamic = "force-dynamic";

/** Sert une pièce jointe d'un message de dossier — réservé aux membres du dossier. */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  // Le module d'abord (la règle partagée le revérifie) : sans lui, inutile de charger la pièce.
  if (!user || !userCan(user, "DOSSIERS", "VIEW")) return new NextResponse(null, { status: 403 });

  const att = await prisma.dossierMessageAttachment.findUnique({
    where: { id: params.id },
    select: {
      blobId: true, name: true, mime: true,
      message: { select: { dossier: { select: { createdById: true, assignedToId: true, participantIds: true } } } },
    },
  });
  if (!att) return new NextResponse(null, { status: 404 });

  if (!peutOuvrirPieceDeSujet(user, att.message.dossier)) return new NextResponse(null, { status: 403 });

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
