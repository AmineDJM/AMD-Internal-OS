import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { readFileByKey } from "@/lib/storage";
import { onlyofficeConfigured, readFileReadToken, readDocReadToken } from "@/lib/onlyoffice";
import { contentDisposition } from "@/lib/http/content-disposition";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { peutLireOnlyoffice } from "@/lib/onlyoffice-session";

export const dynamic = "force-dynamic";

/**
 * Sert le fichier courant au Document Server OnlyOffice (serveur-à-serveur, sans
 * session). L'accès est autorisé par un **jeton signé** émis par la page d'édition
 * (lié au nœud/document + à l'utilisateur). Personne ne peut récupérer un fichier
 * sans jeton valide. Gère le Drive (DriveNode) ET les documents (modèle Document).
 *
 * Le jeton voyage aussi dans le NAVIGATEUR (`document.url` de la configuration de l'éditeur), et le
 * type enregistré est celui que le navigateur de l'auteur a déclaré au dépôt : servi en ligne, un
 * `.docx` déposé comme `text/html` s'ouvrait comme une page de l'ERP. Le Document Server ne lit que
 * les octets — on sert donc toujours en pièce jointe, et un type actif sous bac à sable.
 *
 * Copiable, le jeton n'est plus une clé (audit Drive du 24/11, F4) : il dure une heure, il fige la version ouverte,
 * et le droit de son porteur est RELU ici (compte actif, droit de lecture, hors corbeille). Un refus répond 404 :
 * le Document Server n'a rien à apprendre de plus, et un porteur sans droit non plus.
 */
function entetesServis(nom: string, mime: string, taille: number): Record<string, string> {
  return {
    "Content-Type": mime,
    "Content-Disposition": contentDisposition(nom, "attachment"),
    "X-Content-Type-Options": "nosniff",
    ...entetesAntiExecution(mime),
    "Content-Length": String(taille),
    "Cache-Control": "private, no-store",
  };
}

export async function GET(req: NextRequest) {
  if (!onlyofficeConfigured()) return new NextResponse(null, { status: 404 });
  const token = req.nextUrl.searchParams.get("token");

  // Document (pièces des dossiers / Regulatory / etc.)
  const docTok = readDocReadToken(token);
  if (docTok) {
    const doc = await prisma.document.findUnique({ where: { id: docTok.docId }, select: { name: true, mimeType: true, fileKey: true, version: true } });
    if (!doc?.fileKey) return new NextResponse(null, { status: 404 });
    // Réécrit depuis l'ouverture (le fichier d'un Document se remplace sur place) : ce jeton-là ne sert plus rien.
    if (docTok.version !== undefined && docTok.version !== doc.version) return new NextResponse(null, { status: 404 });
    if (!(await peutLireOnlyoffice(docTok.userId, "document", docTok.docId))) return new NextResponse(null, { status: 404 });
    try {
      const bytes = await readFileByKey(doc.fileKey);
      return new NextResponse(new Uint8Array(bytes), {
        headers: entetesServis(doc.name, doc.mimeType ?? "application/octet-stream", bytes.length),
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
  if (!(await peutLireOnlyoffice(payload.userId, "drive", payload.nodeId))) return new NextResponse(null, { status: 404 });

  // La version FIGÉE à l'ouverture ; un jeton sans version (conversion ponctuelle, cinq minutes) lit la dernière.
  const version = await prisma.fileVersion.findFirst({
    where: { nodeId: payload.nodeId, ...(payload.version !== undefined ? { version: payload.version } : {}) },
    orderBy: { version: "desc" },
    select: { blobId: true, mimeType: true },
  });
  if (!version) return new NextResponse(null, { status: 404 });

  const bytes = await getBlob(version.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: entetesServis(node.name, node.mimeType ?? version.mimeType ?? "application/octet-stream", bytes.length),
  });
}
