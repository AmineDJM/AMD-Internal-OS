import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveDriveAccess } from "@/lib/drive";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { recordAudit } from "@/lib/audit";
import { estUnTexteEditable, texteAEnregistrer } from "@/lib/texte-fichier";
import { TAILLE_MAX_TEXTE_OCTETS } from "@/lib/formats/apercu";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";

export const dynamic = "force-dynamic";
const SANS_CACHE = { "Cache-Control": "no-store" };

async function derniereVersion(nodeId: string) {
  return prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true, version: true, mimeType: true } });
}

/**
 * ENREGISTRER un fichier texte du Drive — une NOUVELLE VERSION (l'ancienne reste dans l'historique). Droit : modifier le
 * fichier. Comparée à la version lue (409 si quelqu'un a enregistré entre-temps) ; un fichier tronqué ne se réécrit jamais.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401, headers: SANS_CACHE });
  if ((await resolveDriveAccess(user, params.id)) !== "EDIT") {
    return NextResponse.json({ error: "Vous n'avez pas le droit de modifier ce fichier." }, { status: 403, headers: SANS_CACHE });
  }
  const node = await prisma.driveNode.findUnique({ where: { id: params.id }, select: { name: true, mimeType: true, type: true } });
  if (!node || node.type !== "FILE") return NextResponse.json({ error: "Introuvable" }, { status: 404, headers: SANS_CACHE });
  if (!estUnTexteEditable(node.name, node.mimeType)) return NextResponse.json({ error: "Ce n'est pas un fichier texte modifiable." }, { status: 415, headers: SANS_CACHE });
  let corps: { texte?: unknown; version?: unknown };
  try { corps = await req.json(); } catch { return NextResponse.json({ error: "Requête illisible." }, { status: 400, headers: SANS_CACHE }); }

  const actuelle = await derniereVersion(params.id);
  if (!actuelle) return NextResponse.json({ error: "Fichier indisponible" }, { status: 404, headers: SANS_CACHE });
  if (corps.version !== actuelle.version) {
    return NextResponse.json({ error: "Quelqu'un a modifié ce fichier depuis que vous l'avez ouvert : rouvrez-le pour voir sa dernière version.", conflit: true }, { status: 409, headers: SANS_CACHE });
  }
  const tailleActuelle = (await getBlob(actuelle.blobId))?.length ?? 0;
  const verifie = texteAEnregistrer(corps.texte, tailleActuelle > TAILLE_MAX_TEXTE_OCTETS);
  if (!verifie.ok) return NextResponse.json({ error: verifie.error }, { status: 400, headers: SANS_CACHE });

  const { blobId, size, sha256 } = await putBlob(verifie.octets);
  const version = actuelle.version + 1;
  try {
    // (nodeId, version) est unique : deux enregistrements simultanés ne créent pas deux fois la même version.
    await prisma.fileVersion.create({ data: { nodeId: params.id, blobId, version, size, mimeType: actuelle.mimeType ?? "text/plain", createdById: user.id } });
  } catch {
    return NextResponse.json({ error: "Quelqu'un vient d'enregistrer ce fichier : rouvrez-le pour voir sa dernière version.", conflit: true }, { status: 409, headers: SANS_CACHE });
  }
  await prisma.driveNode.update({ where: { id: params.id }, data: { size } });
  await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: params.id, summary: `Texte modifié (v${version}) — ${node.name}` });
  // La nouvelle version entre à la bibliothèque (J1) : la clé du nœud passe à ce contenu. Ne lève jamais.
  await inscrireFichierDrive({ nodeId: params.id, version, blobId, sha256, nom: node.name, mime: actuelle.mimeType ?? "text/plain", taille: size, deposeParId: user.id });
  return NextResponse.json({ ok: true, version }, { headers: SANS_CACHE });
}
