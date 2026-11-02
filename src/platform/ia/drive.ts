import { prisma } from "@/lib/prisma";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import type { CurrentUser } from "@/lib/session";
import { fold } from "@/platform/ia/outils/arguments";

/**
 * UN FICHIER DU DRIVE DÉSIGNÉ PAR SON NOM — la résolution que partagent les deux assistants.
 *
 * Écrite pour les ops « fichiers » d'Adam (`lib/assistant/ops/impl-wave8-files.ts`), elle sert aussi
 * les pièces jointes des opérations de l'Assistant IA (`lib/agent/operations/pieces.ts`), qui
 * l'importaient chez Adam — et chargeaient tout Adam pour l'avoir. Déplacée telle quelle au socle.
 */
export interface DriveFileHit { id: string; name: string; size: number; mimeType: string | null }

export const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

/** Un fichier du Drive par NOM : les MIENS d'abord, sinon les fichiers accessibles (bornés, filtrés par droit). */
export async function resolveDriveFile(user: CurrentUser, raw: string): Promise<DriveFileHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nommez le fichier (champ « file ») — un fichier du Drive (glissé dans la conversation ou déposé)." };
  // « Dossier ANPP complet » face à « Dossier ANPP complet.pdf » ET à son extrait « … — pages 2-3.pdf » : le nom exact,
  // extension comprise ou non, tranche (banc T1, DOC-21).
  const pick = (rows: DriveFileHit[]): DriveFileHit | null => {
    if (rows.length === 1) return rows[0];
    const exact = rows.filter((r) => fold(r.name) === fold(q) || fold(sansExtension(r.name)) === fold(sansExtension(q)));
    return exact.length === 1 ? exact[0] : null;
  };
  const mine = await prisma.driveNode.findMany({
    where: { ownerId: user.id, type: "FILE", isTrashed: false, name: { contains: q, mode: "insensitive" } },
    select: { id: true, name: true, size: true, mimeType: true },
    orderBy: { updatedAt: "desc" }, take: 6,
  });
  const own = pick(mine);
  if (own) return own;
  if (mine.length > 1) {
    return { error: `Plusieurs de VOS fichiers correspondent à « ${q} » : ${mine.map((r) => `${r.name} (${kb(r.size)})`).join(" ; ")} — préciser le nom exact.` };
  }
  // Pas à moi : fichiers partagés/accessibles — candidats bornés, droit vérifié UN PAR UN.
  const others = await prisma.driveNode.findMany({
    where: { type: "FILE", isTrashed: false, name: { contains: q, mode: "insensitive" }, NOT: { ownerId: user.id } },
    select: { id: true, name: true, size: true, mimeType: true },
    orderBy: { updatedAt: "desc" }, take: 8,
  });
  const visible: DriveFileHit[] = [];
  for (const r of others) {
    if (canViewDrive(await resolveDriveAccess(user, r.id))) visible.push(r);
  }
  const shared = pick(visible);
  if (shared) return shared;
  if (visible.length > 1) {
    return { error: `Plusieurs fichiers accessibles correspondent à « ${q} » : ${visible.map((r) => `${r.name} (${kb(r.size)})`).join(" ; ")} — préciser le nom exact.` };
  }
  // PAR LES MOTS (banc T1 : « le scan du cachet de la pharmacie » → « Scan cachet pharmacie.png ») : parmi SES fichiers et
  // ceux qu'on lui a partagés, celui dont le nom porte TOUS les mots significatifs, accents et ordre ignorés — un seul.
  const parMots = await parLesMots(user, q);
  if (parMots) return parMots;
  return { error: `Aucun fichier « ${q} » dans votre Drive ni parmi les fichiers qui vous sont accessibles — déposez-le (ou glissez-le dans la conversation) puis redemandez.` };
}

const sansExtension = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, "");
const MOTS_VIDES = new Set(["les", "des", "une", "mon", "mes", "ton", "tes", "son", "ses", "notre", "nos", "votre", "vos", "pour", "avec", "dans", "sur", "par", "qui", "que", "fichier", "document", "doc", "pdf", "word", "excel", "the"]);

async function parLesMots(user: CurrentUser, q: string): Promise<DriveFileHit | { error: string } | null> {
  const visibles = await candidatsParLesMots(user, q);
  if (visibles.length === 1) return visibles[0];
  if (visibles.length > 1) return { error: `Plusieurs fichiers correspondent à « ${q} » : ${visibles.map((r) => `${r.name} (${kb(r.size)})`).join(" ; ")} — préciser le nom exact.` };
  return null;
}

/** Les fichiers (les siens, ceux qu'on lui a partagés) dont le nom porte TOUS les mots significatifs de `q` — visibles, 6 au plus. */
export async function candidatsParLesMots(user: CurrentUser, q: string): Promise<DriveFileHit[]> {
  const mots = [...new Set(fold(sansExtension(q)).split(" ").filter((m) => m.length >= 2 && !MOTS_VIDES.has(m) && !/^(de|du|la|le|l|d|au|et|a|en)$/.test(m)))];
  if (mots.length < 2) return [];
  const candidats = await prisma.driveNode.findMany({
    where: { type: "FILE", isTrashed: false, OR: [{ ownerId: user.id }, { shares: { some: { userId: user.id } } }] },
    select: { id: true, name: true, size: true, mimeType: true },
    orderBy: { updatedAt: "desc" }, take: 800,
  });
  const hits = candidats.filter((r) => { const n = ` ${fold(r.name)} `; return mots.every((m) => n.includes(` ${m}`)); });
  const visibles: DriveFileHit[] = [];
  for (const r of hits.slice(0, 6)) if (canViewDrive(await resolveDriveAccess(user, r.id))) visibles.push(r);
  return visibles;
}

/** Reconstruit un File réel depuis le Drive à l'EXÉCUTION — droits revérifiés, dernière version. */
export async function driveNodeToFile(user: CurrentUser, nodeId: string): Promise<File | { error: string }> {
  if (!canViewDrive(await resolveDriveAccess(user, nodeId))) return { error: "Ce fichier du Drive ne vous est plus accessible." };
  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true, type: true, mimeType: true, isTrashed: true } });
  if (!node || node.type !== "FILE" || node.isTrashed) return { error: "Fichier du Drive introuvable (déplacé ou supprimé ?)." };
  const version = await prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  if (!version) return { error: "Ce fichier n'a aucun contenu téléversé." };
  const bytes = await getBlob(version.blobId);
  if (!bytes || bytes.length === 0) return { error: "Le contenu du fichier est illisible dans le stockage." };
  return new File([new Uint8Array(bytes)], node.name, { type: node.mimeType ?? "application/octet-stream" });
}
