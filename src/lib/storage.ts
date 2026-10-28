import { readFile } from "fs/promises";
import path from "path";
import { prisma } from "./prisma";
import { putBlob, getBlob, releaseBlob } from "./drive-storage";
import { refusTeleversement } from "./files/politique-televersement";

/**
 * Stockage des fichiers de **documents** (modèle Document, hors Drive).
 *
 * Le contenu est conservé **en base** (table `FileBlob` : chiffré AES-256-GCM,
 * dédupliqué), via une table de correspondance `StoredFile` (clé opaque → blob).
 * C'est **durable** : contrairement au disque local (éphémère sur Render, perdu à
 * chaque redéploiement → « erreur de téléchargement »), les fichiers survivent.
 *
 * Compatibilité : `readFileByKey` retombe sur l'ancien dossier `./uploads` si une
 * clé n'a pas (encore) d'entrée en base — pour ne pas casser les fichiers locaux.
 */

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

export function isRemoteStorage() {
  // Le stockage est désormais la base (durable) ; plus de dépendance disque/S3.
  return true;
}

/**
 * Écrit (ou remplace) le contenu d'une clé — durable, chiffré, en base. Rend le blob et l'EMPREINTE
 * (SHA-256 du contenu) : l'identité de la pièce pour l'enrichissement (`enrichissement/signalement.ts`).
 * Les appelants d'avant, qui n'attendaient rien, n'ont rien à changer.
 */
export async function saveFile(key: string, buffer: Buffer): Promise<{ blobId: string; sha256: string }> {
  const { blobId, size, sha256 } = await putBlob(buffer);
  const previous = await prisma.storedFile.findUnique({ where: { key }, select: { blobId: true } });
  await prisma.storedFile.upsert({
    where: { key },
    create: { key, blobId, size },
    update: { blobId, size },
  });
  // Si la clé pointait sur un autre blob, on libère l'ancien (ref-count).
  if (previous && previous.blobId !== blobId) await releaseBlob(previous.blobId);
  return { blobId, sha256 };
}

export async function readFileByKey(key: string): Promise<Buffer> {
  const stored = await prisma.storedFile.findUnique({ where: { key }, select: { blobId: true } });
  if (stored) {
    const bytes = await getBlob(stored.blobId);
    if (bytes) return bytes;
  }
  // Repli : ancien fichier écrit sur le disque local (dev / avant migration).
  return readFile(path.join(UPLOAD_DIR, key));
}

export async function deleteFileByKey(key: string): Promise<void> {
  const stored = await prisma.storedFile.findUnique({ where: { key }, select: { blobId: true } });
  if (stored) {
    // La référence part AVANT de rendre le blob : `releaseBlob` n'efface que ce qu'aucune
    // colonne ne désigne plus, et cette ligne en est une.
    await prisma.storedFile.delete({ where: { key } }).catch(() => undefined);
    await releaseBlob(stored.blobId);
  }
}

/**
 * UNE SEULE POLITIQUE DE TYPES pour tous les dépôts (audit du 04/10, constat 9) — voir
 * `@/lib/files/politique-televersement`. Les trois fonctions restent, parce que leurs appelants
 * sont nombreux et que la TAILLE par défaut diffère (Drive plus large) ; le TYPE, lui, se juge
 * partout de la même façon.
 */
export function validateUpload(
  filename: string,
  sizeBytes: number,
  maxMb = Number(process.env.MAX_UPLOAD_MB ?? "25"),
): string | null {
  return refusTeleversement(filename, sizeBytes, maxMb);
}

/** Validation des imports **Drive** : même politique, limite de taille plus large (configurable). */
export function validateDriveUpload(
  filename: string,
  sizeBytes: number,
  maxMb = Number(process.env.MAX_DRIVE_UPLOAD_MB ?? process.env.MAX_UPLOAD_MB ?? "100"),
): string | null {
  return refusTeleversement(filename, sizeBytes, maxMb);
}

/** Validation des imports **Documents** (dossiers CTD, factures, pièces des objets métier…). */
export function validateDocumentUpload(
  filename: string,
  sizeBytes: number,
  maxMb = Number(process.env.MAX_UPLOAD_MB ?? "25"),
): string | null {
  return refusTeleversement(filename, sizeBytes, maxMb);
}
