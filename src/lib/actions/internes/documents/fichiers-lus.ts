import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canViewDrive, resolveDriveAccess } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";

/**
 * LES FICHIERS DU DRIVE, LUS SOUS LES DROITS DE LA PERSONNE (lot T1, décision 0053) — ce que les gestes qui rangent ou
 * assemblent des pièces doivent lire : le droit du Drive (`resolveDriveAccess`), la dernière version, son texte LOCAL
 * (aucun service externe : `lireFichierUneFois` sans moteur cloud). Lectures seulement.
 */

export async function peutVoirAuDrive(user: CurrentUser, nodeId: string): Promise<boolean> {
  return canViewDrive(await resolveDriveAccess(user, nodeId));
}

/** Les octets de la dernière version — `null` si la personne ne voit pas le fichier ou s'il est vide. */
export async function octetsDuFichier(user: CurrentUser, nodeId: string): Promise<Buffer | null> {
  if (!(await peutVoirAuDrive(user, nodeId))) return null;
  const v = await prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  if (!v) return null;
  const b = await getBlob(v.blobId);
  return b?.length ? b : null;
}

/** Le TEXTE d'un fichier (PDF, Word, texte), lu localement et borné — pour y lire des dates, une partie. */
export async function texteDuFichierLu(user: CurrentUser, nodeId: string, nom: string, maxPages = 6): Promise<string> {
  const octets = await octetsDuFichier(user, nodeId);
  if (!octets) return "";
  const ext = nom.includes(".") ? nom.slice(nom.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["txt", "md", "csv"].includes(ext)) return octets.toString("utf8").slice(0, 60_000);
  const lu = await lireFichierUneFois({ octets, ext, cloud: false, maxPages, userId: user.id });
  return lu.ok ? lu.lecture.texte.slice(0, 60_000) : "";
}
