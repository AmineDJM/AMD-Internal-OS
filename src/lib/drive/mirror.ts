import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";

/**
 * LES DEUX GESTES DE TOUT MIROIR DRIVE : trouver-ou-créer un dossier, y déposer un fichier.
 *
 * Trois modules les réécrivaient à l'identique (Regulatory, RH, archivage des demandes). Ce n'est
 * pas seulement de la répétition : c'est trois occasions de diverger sur la seule règle qui
 * compte — **re-déposer un fichier de même nom au même endroit crée une VERSION, pas un doublon**.
 * Un drive qui accumule « devis.pdf », « devis (1).pdf », « devis (2).pdf » ne se relit plus.
 */

/** Trouve — ou crée — un dossier de ce nom, sous ce parent, pour ce propriétaire. Idempotent. */
export async function ensureDriveFolder(name: string, parentId: string | null, ownerId: string): Promise<string> {
  const existing = await prisma.driveNode.findFirst({
    where: { type: "FOLDER", name, parentId, ownerId, isTrashed: false },
    select: { id: true },
  });
  if (existing) return existing.id;
  const node = await prisma.driveNode.create({
    data: { name, type: "FOLDER", parentId, ownerId, createdById: ownerId },
    select: { id: true },
  });
  return node.id;
}

/** Descend (en créant au besoin) un chemin de dossiers, et rend l'id du dernier. */
export async function ensureDrivePath(segments: readonly string[], ownerId: string, rootId: string | null = null): Promise<string | null> {
  let parentId = rootId;
  for (const seg of segments) parentId = await ensureDriveFolder(seg, parentId, ownerId);
  return parentId;
}

/**
 * Dépose un fichier dans un dossier du Drive. Même nom au même endroit → **nouvelle version**.
 * Rend le nœud et `cree` (vrai pour un fichier neuf, faux pour une version de plus). Le fichier entre à la
 * bibliothèque (J1) sous la clé de son nœud — un endroit de plus pour la même pièce, sans relecture.
 */
export async function deposerFichierDrive(opts: {
  parentId: string;
  name: string;
  data: Buffer;
  mimeType?: string | null;
  ownerId: string;
  /** À la création seulement : l'espace (catégorie partagée) et la catégorie du nœud. */
  spaceId?: string | null;
  category?: string | null;
  /** Une pièce RH (contrat) entre confidentielle. */
  confidentielle?: boolean;
}): Promise<{ nodeId: string; cree: boolean }> {
  const { blobId, size, sha256 } = await putBlob(opts.data);
  const mimeType = opts.mimeType || "application/octet-stream";
  const inscrire = (nodeId: string, version?: number) => inscrireFichierDrive({
    nodeId, version, blobId, sha256, nom: opts.name, mime: mimeType, taille: size, deposeParId: opts.ownerId,
    ...(opts.confidentielle ? { source: "RH" as const, confidentialite: "CONFIDENTIAL" as const } : {}),
  });

  const existing = await prisma.driveNode.findFirst({
    where: { type: "FILE", name: opts.name, parentId: opts.parentId, isTrashed: false },
    select: { id: true },
  });
  if (existing) {
    const last = await prisma.fileVersion.findFirst({
      where: { nodeId: existing.id }, orderBy: { version: "desc" }, select: { version: true },
    });
    const version = (last?.version ?? 0) + 1;
    await prisma.fileVersion.create({ data: { nodeId: existing.id, blobId, version, size, mimeType, createdById: opts.ownerId } });
    await prisma.driveNode.update({ where: { id: existing.id }, data: { size, mimeType } });
    await inscrire(existing.id, version);
    return { nodeId: existing.id, cree: false };
  }
  const cree = await prisma.driveNode.create({
    data: {
      name: opts.name, type: "FILE", parentId: opts.parentId, ownerId: opts.ownerId, spaceId: opts.spaceId ?? null,
      category: opts.category ?? null, mimeType, size, createdById: opts.ownerId,
      versions: { create: { blobId, version: 1, size, mimeType, createdById: opts.ownerId } },
    },
    select: { id: true },
  });
  await inscrire(cree.id);
  return { nodeId: cree.id, cree: true };
}

/** La forme historique : rend `true` si le fichier était nouveau, `false` s'il s'agit d'une version de plus. */
export async function putDriveFile(opts: { parentId: string; name: string; data: Buffer; mimeType?: string | null; ownerId: string }): Promise<boolean> {
  return (await deposerFichierDrive(opts)).cree;
}
