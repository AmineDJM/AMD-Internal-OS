import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { readFileByKey } from "@/lib/storage";
import { onlyofficeConfigured, readFileReadToken, readDocReadToken } from "@/lib/onlyoffice";

export const dynamic = "force-dynamic";

/**
 * Sert le fichier courant au Document Server OnlyOffice (serveur-à-serveur, sans
 * session). L'accès est autorisé par un **jeton signé** émis par la page d'édition
 * (lié au nœud/document + à l'utilisateur). Personne ne peut récupérer un fichier
 * sans jeton valide. Gère le Drive (DriveNode) ET les documents (modèle Document).
 */
export async function GET(req: NextRequest) {
  if (!onlyofficeConfigured()) return new NextResponse(null, { status: 404 });
  const token = req.nextUrl.searchParams.get("token");

  // Document (pièces des dossiers / Regulatory / etc.)
  const docTok = readDocReadToken(token);
  if (docTok) {
    const doc = await prisma.document.findUnique({ where: { id: docTok.docId }, select: { name: true, mimeType: true, fileKey: true } });
    if (!doc?.fileKey) return new NextResponse(null, { status: 404 });
    try {
      const bytes = await readFileByKey(doc.fileKey);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": doc.mimeType ?? "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
        },
      });
    } catch {
      return new NextResponse(null, { status: 404 });
    }
  }

  const payload = readFileReadToken(token);
  if (!payload) return new NextResponse(null, { status: 401 });

  const node = await prisma.driveNode.findUnique({
    where: { id: payload.nodeId },
    select: { name: true, mimeType: true, type: true },
  });
  if (!node || node.type !== "FILE") return new NextResponse(null, { status: 404 });

  const version = await prisma.fileVersion.findFirst({
    where: { nodeId: payload.nodeId },
    orderBy: { version: "desc" },
    select: { blobId: true, mimeType: true },
  });
  if (!version) return new NextResponse(null, { status: 404 });

  const bytes = await getBlob(version.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": node.mimeType ?? version.mimeType ?? "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
