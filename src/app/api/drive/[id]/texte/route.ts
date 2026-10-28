import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import { estUnTexteEditable, lireTexte } from "@/lib/texte-fichier";

export const dynamic = "force-dynamic";
const SANS_CACHE = { "Cache-Control": "no-store" };

async function derniereVersion(nodeId: string) {
  return prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true, version: true, mimeType: true } });
}

/** LIRE un fichier texte du Drive (JSON : texte, version, tronqué, modifiable). Mêmes droits que la lecture du fichier. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401, headers: SANS_CACHE });
  const acces = await resolveDriveAccess(user, params.id);
  if (!canViewDrive(acces)) return NextResponse.json({ error: "Accès refusé" }, { status: 403, headers: SANS_CACHE });
  const node = await prisma.driveNode.findUnique({ where: { id: params.id }, select: { name: true, mimeType: true, type: true } });
  if (!node || node.type !== "FILE") return NextResponse.json({ error: "Introuvable" }, { status: 404, headers: SANS_CACHE });
  if (!estUnTexteEditable(node.name, node.mimeType)) return NextResponse.json({ error: "Ce n'est pas un fichier texte." }, { status: 415, headers: SANS_CACHE });
  const v = await derniereVersion(params.id);
  const octets = v ? await getBlob(v.blobId) : null;
  if (!v || !octets) return NextResponse.json({ error: "Fichier indisponible" }, { status: 404, headers: SANS_CACHE });
  const { texte, tronque } = lireTexte(octets);
  return NextResponse.json({ texte, tronque, modifiable: acces === "EDIT" && !tronque, version: v.version }, { headers: SANS_CACHE });
}
