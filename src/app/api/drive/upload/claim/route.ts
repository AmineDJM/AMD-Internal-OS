import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { resolveDriveAccess, effectiveSpaceId, canCreateInSpace, canViewDrive } from "@/lib/drive";
import { quotaVerdict } from "@/lib/drive/quota";
import { userUsageBytes, physicalUsageBytes } from "@/lib/drive/usage";
import { recordAudit } from "@/lib/audit";
import { attendu } from "@/lib/journal";

/**
 * TÉLÉVERSEMENT INSTANTANÉ — quand le contenu est DÉJÀ là, on n'envoie pas les octets.
 *
 * Le stockage est adressé par le contenu : deux fichiers identiques partagent un seul blob. Mais
 * la déduplication ne se découvrait qu'APRÈS avoir tout envoyé au serveur. Re-déposer une
 * arborescence de 300 Mo dont 90 % existe déjà coûtait donc 300 Mo de réseau pour n'écrire
 * presque rien.
 *
 * Le navigateur calcule l'empreinte du fichier et la présente ici. Si le contenu est connu, on
 * crée le fichier en une requête, sans transférer un octet — c'est instantané, quelle que soit la
 * taille. Sinon on répond « inconnu » et l'envoi normal démarre.
 *
 * ── Pourquoi on ne se contente pas de « cette empreinte existe » ──
 * Connaître l'empreinte d'un fichier, c'est en posséder le contenu. Accepter n'importe quelle
 * empreinte transformerait cette route en oracle : « ce document précis est-il quelque part dans
 * l'ERP ? ». On exige donc que le demandeur puisse DÉJÀ VOIR au moins un fichier portant ce
 * contenu. Le cas courant — je redépose un fichier que j'ai, ou je réimporte un dossier — passe ;
 * l'oracle, non.
 */

/** Au-delà, on cesse de chercher : si aucune des premières copies n'est visible, l'envoi normal suffit. */
const MAX_CANDIDATES = 25;

export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Mot de passe à changer." }, { status: 403 });

  const body = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", null))) as {
    sha256?: string; name?: string; size?: number;
    parentId?: string | null; spaceId?: string | null; category?: string | null;
    viewers?: string[]; editors?: string[];
  } | null;

  const hash = (body?.sha256 ?? "").trim().toLowerCase();
  const name = (body?.name ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(hash) || !name) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

  const parentId = body?.parentId || null;
  const spaceId = body?.spaceId || null;

  // Mêmes gardes que l'envoi normal — le chemin rapide ne doit ouvrir aucune porte de plus.
  if (parentId) {
    if ((await resolveDriveAccess(user, parentId)) !== "EDIT") return NextResponse.json({ error: "Dossier non autorisé." }, { status: 403 });
  } else if (spaceId) {
    if (!(await canCreateInSpace(user, spaceId))) return NextResponse.json({ error: "Catégorie non autorisée." }, { status: 403 });
  } else if (!userCan(user, "DRIVE", "UPLOAD")) {
    return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  }

  const blob = await prisma.fileBlob.findUnique({ where: { sha256: hash }, select: { id: true, size: true } });
  if (!blob) return NextResponse.json({ known: false });

  // Le demandeur voit-il déjà une copie de ce contenu ? Sinon : pas d'oracle, envoi normal.
  const carriers = await prisma.fileVersion.findMany({
    where: { blobId: blob.id }, select: { nodeId: true }, take: MAX_CANDIDATES, orderBy: { id: "asc" },
  });
  let reachable = false;
  for (const c of carriers) {
    if (canViewDrive(await resolveDriveAccess(user, c.nodeId))) { reachable = true; break; }
  }
  if (!reachable) return NextResponse.json({ known: false });

  // Les quotas s'appliquent quand même : le fichier compte dans l'espace de la personne, même si
  // le contenu ne prend pas de place NEUVE sur le disque (d'où la capacité globale inchangée).
  const settings = await getAppSettings();
  const [myUsage, physical] = await Promise.all([userUsageBytes(user.id), physicalUsageBytes()]);
  const verdict = quotaVerdict({
    userUsageBytes: myUsage, physicalUsageBytes: physical, fileSize: 0,
    userQuotaGb: settings.driveUserQuotaGb, capacityGb: settings.driveCapacityGb,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });

  const mimeType = mimeOf(name);
  const category = (body?.category ?? "").trim() || null;
  const effSpaceId = await effectiveSpaceId(parentId, spaceId);

  await prisma.fileBlob.update({ where: { id: blob.id }, data: { refCount: { increment: 1 } } });
  const node = await prisma.driveNode.create({
    data: {
      name, type: "FILE", parentId, spaceId: effSpaceId, ownerId: user.id,
      mimeType, size: blob.size, category, createdById: user.id,
      versions: { create: { blobId: blob.id, version: 1, size: blob.size, mimeType, createdById: user.id } },
    },
    select: { id: true },
  });

  const editorIds = new Set((body?.editors ?? []).filter((id) => id && id !== user.id));
  const viewerIds = new Set((body?.viewers ?? []).filter((id) => id && id !== user.id && !editorIds.has(id)));
  const ids = [...editorIds, ...viewerIds];
  if (ids.length) {
    const valid = new Set(
      (await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } })).map((u) => u.id),
    );
    const shareData = [
      ...[...editorIds].filter((id) => valid.has(id)).map((userId) => ({ nodeId: node.id, userId, access: "EDIT" as const })),
      ...[...viewerIds].filter((id) => valid.has(id)).map((userId) => ({ nodeId: node.id, userId, access: "VIEW" as const })),
    ];
    if (shareData.length) await prisma.driveShare.createMany({ data: shareData, skipDuplicates: true });
  }

  await recordAudit({
    actorId: user.id, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: node.id,
    summary: `Fichier « ${name} » (contenu déjà présent — aucun transfert)${category ? ` · ${category}` : ""}`,
  });
  return NextResponse.json({ known: true, id: node.id });
}

/** Type MIME depuis l'extension — le navigateur ne l'envoie pas ici, et il ne sert qu'à l'affichage. */
function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", zip: "application/zip", txt: "text/plain", csv: "text/csv",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp4: "video/mp4", mp3: "audio/mpeg",
  };
  return map[ext] ?? "application/octet-stream";
}
