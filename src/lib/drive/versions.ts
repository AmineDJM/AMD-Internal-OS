import { prisma } from "@/lib/prisma";
import { releaseBlob } from "@/lib/drive-storage";
import { sansBloquer } from "@/lib/journal";

/**
 * AJOUTER UNE VERSION À UN FICHIER DU DRIVE — le numéro se prend SOUS VERROU (audit du Drive, 24/11, point A3).
 *
 * `MAX(version) + 1` lu hors transaction : deux enregistrements simultanés (deux rappels de l'éditeur Office, deux
 * dépôts d'une nouvelle version) lisaient le même maximum, l'un des deux tombait sur l'unicité (nodeId, version) — P2002 —
 * et son contenu, déjà écrit, restait compté sans que rien ne le tienne : une modification perdue, un blob orphelin.
 * Le verrou consultatif de transaction range les écritures d'un même fichier l'une derrière l'autre ; la seconde lit
 * le numéro posé par la première.
 */
export async function ajouterVersionDrive(v: {
  nodeId: string;
  blobId: string;
  size: number;
  /** `undefined` : le type de la version précédente (l'éditeur réécrit le même format). */
  mimeType?: string;
  createdById: string;
  /** Statut 6 de l'éditeur Office : la session continue, sa clé d'édition ne change pas. */
  forcesave?: boolean;
}): Promise<{ version: number; mimeType: string }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('drive-version'), hashtext(${v.nodeId}))`;
    const last = await tx.fileVersion.findFirst({ where: { nodeId: v.nodeId }, orderBy: { version: "desc" }, select: { version: true, mimeType: true } });
    const version = (last?.version ?? 0) + 1;
    const mimeType = v.mimeType ?? last?.mimeType ?? "application/octet-stream";
    await tx.fileVersion.create({
      data: { nodeId: v.nodeId, blobId: v.blobId, version, size: v.size, mimeType, createdById: v.createdById, forcesave: v.forcesave ?? false },
    });
    await tx.driveNode.update({ where: { id: v.nodeId }, data: { size: v.size, ...(v.mimeType !== undefined ? { mimeType } : {}) } });
    return { version, mimeType };
  });
}

/**
 * RENDRE LE BLOB d'une écriture qui n'a pas abouti : `putBlob` l'a compté pour l'appelant, et aucune ligne ne le tient.
 * Ne lève jamais — l'échec d'origine est celui qu'on rapporte.
 */
export async function rendreBlobOrphelin(blobId: string, ou: string): Promise<void> {
  await releaseBlob(blobId).catch(sansBloquer(ou));
}
