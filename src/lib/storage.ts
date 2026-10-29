import { readFile } from "fs/promises";
import path from "path";
import { prisma } from "./prisma";
import { putBlob, getBlob, releaseBlob } from "./drive-storage";
import { refusTeleversement } from "./files/politique-televersement";
import { sansBloquer } from "@/lib/journal";
import { randomUUID } from "node:crypto";
import type { Confidentiality, DocumentCategory, EntityType } from "@prisma/client";
import { inscrireDocumentEcrit } from "@/modules/bibliotheque/api-inscription";

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
    await prisma.storedFile.delete({ where: { key } }).catch(sansBloquer("storage.deleteFileByKey.storedFile"));
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

/**
 * DÉPOSER UNE PIÈCE DE MODULE, simplement — le fichier au coffre, la fiche `Document`, son inscription à la
 * bibliothèque (J1) : le geste que neuf écrivains répétaient (justificatifs d'une dépense, d'un BV, d'une
 * formation, d'une directive, d'une validation, d'une demande RH, d'un congé, d'une information médicale).
 *
 * Une écriture au coffre ratée GARDE la fiche (métadonnées seules) : une pièce annoncée puis introuvable se voit
 * et se redemande ; une pièce silencieusement disparue laisse croire au dépôt. Rien n'est alors inscrit — il n'y a
 * rien à lire. (`persistUploadedDocument`, `lib/documents.ts`, est le dépôt complet : versions, miroir Drive.)
 */
export async function deposerPieceDeModule(file: File, d: {
  entityType: EntityType; entityId: string; category: DocumentCategory; confidentiality: Confidentiality;
  uploadedById: string | null; stepKey?: string | null; journal: string;
}): Promise<{ id: string }> {
  const key = `${d.entityType}/${d.entityId}/${randomUUID()}__${file.name}`;
  let ecrit: { blobId: string; sha256: string } | null = null;
  try {
    // `saveFile` sur une clé NEUVE (aléa) : le blob et sa correspondance, écrits ici pour que le contrat des actions
    // voie l'écriture de `StoredFile` (il lit un niveau d'appel, `actions/contrat/ecritures.ts`).
    const { blobId, size, sha256 } = await putBlob(Buffer.from(await file.arrayBuffer()));
    await prisma.storedFile.create({ data: { key, blobId, size } });
    ecrit = { blobId, sha256 };
  } catch (err) {
    console.error(`[${d.journal}] storage write failed, recording metadata only`, err);
  }
  const doc = await prisma.document.create({
    data: {
      name: file.name, category: d.category, entityType: d.entityType, entityId: d.entityId, stepKey: d.stepKey ?? null,
      fileKey: key, mimeType: file.type || null, sizeBytes: file.size, confidentiality: d.confidentiality, uploadedById: d.uploadedById,
    },
    select: { id: true, entityType: true, category: true, confidentiality: true, name: true, mimeType: true, sizeBytes: true, uploadedById: true },
  });
  await inscrireDocumentEcrit(doc, ecrit);
  return { id: doc.id };
}
