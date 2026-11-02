import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { readFileByKey } from "@/lib/storage";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";

/**
 * Archivage des demandes TRAITÉES dans le Drive : chaque traitant (RH, bureau du
 * secrétariat, PRIM…) a à la racine de son Drive une boîte « Dossier traité »,
 * avec un sous-dossier par bureau, puis un dossier par demande contenant un
 * fichier récapitulatif + la copie des pièces jointes. Il peut ensuite les
 * reclasser librement dans ses dossiers (déplacer / renommer).
 *
 * L'archivage ne doit JAMAIS faire échouer le traitement : toute erreur est
 * journalisée et la fonction rend simplement null.
 */

const ROOT_NAME = "Dossier traité";

export type ArchiveBureau = "RH" | "Bureau du secrétariat" | "Information médicale";

/** Dossier (réutilisé s'il existe déjà au même endroit pour ce propriétaire). */
async function ensureFolder(name: string, parentId: string | null, ownerId: string): Promise<string> {
  const existing = await prisma.driveNode.findFirst({
    where: { name, parentId: parentId ?? null, ownerId, type: "FOLDER", isTrashed: false },
    select: { id: true },
  });
  if (existing) return existing.id;
  const node = await prisma.driveNode.create({
    data: { name, type: "FOLDER", parentId: parentId ?? null, ownerId, createdById: ownerId },
    select: { id: true },
  });
  return node.id;
}

async function addFile(parentId: string, name: string, content: Buffer, mimeType: string, ownerId: string): Promise<void> {
  const { blobId, size, sha256 } = await putBlob(content);
  const node = await prisma.driveNode.create({
    data: { name, type: "FILE", parentId, ownerId, createdById: ownerId, mimeType, size },
    select: { id: true },
  });
  await prisma.fileVersion.create({ data: { nodeId: node.id, blobId, version: 1, size, mimeType, createdById: ownerId } });
  // Le fichier archivé entre à la bibliothèque (J1). Ne lève jamais.
  await inscrireFichierDrive({ nodeId: node.id, blobId, sha256, nom: name, mime: mimeType, taille: size, deposeParId: ownerId });
}

export interface ArchiveAttachment {
  name: string;
  /** Clé dans le stockage Documents (copiée vers le Drive). */
  fileKey: string | null;
  mimeType?: string | null;
}

export async function archiveProcessedRequest(opts: {
  bureau: ArchiveBureau;
  /** Nom du dossier de la demande, ex. « 2026-07-05 — Note de frais — A. Benali ». */
  folderName: string;
  /** Contenu du fichier récapitulatif « Demande.txt ». */
  summary: string;
  attachments?: ArchiveAttachment[];
  /** Pièces déjà en mémoire (ex. document RH chiffré déposé en réponse). */
  extraFiles?: { name: string; content: Buffer; mimeType?: string | null }[];
  /** Le traitant : la boîte « Dossier traité » est créée dans SON drive. */
  ownerId: string;
}): Promise<string | null> {
  try {
    const rootId = await ensureFolder(ROOT_NAME, null, opts.ownerId);
    const bureauId = await ensureFolder(opts.bureau, rootId, opts.ownerId);
    // Un dossier NEUF par demande (pas de fusion en cas d'homonymie).
    const reqFolder = await prisma.driveNode.create({
      data: { name: opts.folderName.slice(0, 180), type: "FOLDER", parentId: bureauId, ownerId: opts.ownerId, createdById: opts.ownerId },
      select: { id: true },
    });

    await addFile(reqFolder.id, "Demande.txt", Buffer.from(opts.summary, "utf8"), "text/plain; charset=utf-8", opts.ownerId);

    for (const att of opts.attachments ?? []) {
      if (!att.fileKey) continue;
      try {
        const buf = await readFileByKey(att.fileKey);
        await addFile(reqFolder.id, att.name, buf, att.mimeType || "application/octet-stream", opts.ownerId);
      } catch (err) {
        console.error("[archive] pièce illisible, ignorée :", att.name, err);
      }
    }
    for (const extra of opts.extraFiles ?? []) {
      try {
        await addFile(reqFolder.id, extra.name, extra.content, extra.mimeType || "application/octet-stream", opts.ownerId);
      } catch (err) {
        console.error("[archive] fichier additionnel ignoré :", extra.name, err);
      }
    }
    return reqFolder.id;
  } catch (err) {
    console.error("[archive] échec de l'archivage Drive", err);
    return null;
  }
}
