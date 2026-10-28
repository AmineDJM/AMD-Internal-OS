import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { peutLirePasseportDuSujet } from "@/lib/ad-pro/passeport-acces";
import { prisma } from "@/lib/prisma";
import { readFileByKey } from "@/lib/storage";
import { estUnTexteEditable, lireTexte } from "@/lib/texte-fichier";

export const dynamic = "force-dynamic";
const SANS_CACHE = { "Cache-Control": "no-store" };

/** LIRE un document texte (JSON : texte, version, tronqué, modifiable). Mêmes droits que le téléchargement. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401, headers: SANS_CACHE });
  const doc = await prisma.document.findUnique({ where: { id: params.id } });
  if (!doc) return NextResponse.json({ error: "Introuvable" }, { status: 404, headers: SANS_CACHE });
  const lisible = (await canAccessEntity(user, doc.entityType, doc.entityId, "VIEW")) || (await peutLirePasseportDuSujet(user.id, doc));
  if (!lisible) return NextResponse.json({ error: "Accès refusé" }, { status: 403, headers: SANS_CACHE });
  if (!doc.fileKey) return NextResponse.json({ error: "Aucun fichier binaire associé." }, { status: 404, headers: SANS_CACHE });
  if (!estUnTexteEditable(doc.name, doc.mimeType)) return NextResponse.json({ error: "Ce n'est pas un fichier texte." }, { status: 415, headers: SANS_CACHE });
  try {
    const { texte, tronque } = lireTexte(await readFileByKey(doc.fileKey));
    const modifiable = !tronque && (await canAccessEntity(user, doc.entityType, doc.entityId, "UPLOAD"));
    return NextResponse.json({ texte, tronque, modifiable, version: doc.version }, { headers: SANS_CACHE });
  } catch {
    return NextResponse.json({ error: "Fichier indisponible" }, { status: 404, headers: SANS_CACHE });
  }
}
