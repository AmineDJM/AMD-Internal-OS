import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canViewDrive, resolveDriveAccess } from "@/lib/drive";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive, refusDepotDrive } from "@/lib/drive/depot";
import { DOSSIERS_ESPACE_ADAM, ICONE_ESPACE_ADAM, NOM_ESPACE_ADAM } from "@/lib/drive/espace-adam";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ESPACE D'ADAM — l'écriture (lot I3, décision 0065, audit AU2 §6.1 (e)).
 *
 * UN `DriveSpace` PAR PERSONNE, le modèle existant (aucune migration) : `accessUserIds` = `managerUserIds` = [elle],
 * aucun rôle. Adam y a les droits de la personne, personne d'autre (`estEspaceAdamDAutrui` le retire des onglets de
 * tous les autres, Super Admin compris). Dossiers « Brouillons » (ce qu'Adam produit) et « Copies » (ce qu'il copie ou
 * convertit), rangement libre en sous-dossiers.
 *
 * Écrire passe par la porte du dépôt de l'écran (`refusDepotDrive` puis `enregistrerFichierDrive`) : mêmes droits,
 * même audit, même inscription à la Bibliothèque. Un fichier du même nom dans le même dossier reçoit une NOUVELLE
 * VERSION (l'ancienne reste : l'annulation K10 la rétablit).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EspaceAdam { spaceId: string; dossiers: Record<string, string> }

/** L'espace d'Adam de la personne — créé à la première écriture, avec ses dossiers. */
export async function espaceDAdam(userId: string): Promise<EspaceAdam> {
  const existant = await prisma.driveSpace.findFirst({
    where: { name: NOM_ESPACE_ADAM, icon: ICONE_ESPACE_ADAM, isArchived: false, accessUserIds: { equals: [userId] }, managerUserIds: { equals: [userId] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const spaceId = existant?.id ?? (await prisma.driveSpace.create({
    data: { name: NOM_ESPACE_ADAM, icon: ICONE_ESPACE_ADAM, accessUserIds: [userId], managerUserIds: [userId], createdById: userId },
    select: { id: true },
  })).id;
  const dossiers: Record<string, string> = {};
  for (const nom of DOSSIERS_ESPACE_ADAM) dossiers[nom] = await dossierDansEspace(userId, spaceId, null, nom);
  return { spaceId, dossiers };
}

async function dossierDansEspace(userId: string, spaceId: string, parentId: string | null, nom: string): Promise<string> {
  const d = await prisma.driveNode.findFirst({ where: { type: "FOLDER", name: nom, spaceId, parentId, isTrashed: false }, select: { id: true } });
  if (d) return d.id;
  return (await prisma.driveNode.create({ data: { name: nom, type: "FOLDER", spaceId, parentId, ownerId: userId, createdById: userId }, select: { id: true } })).id;
}

/** Le dossier désigné (« Brouillons », « Copies/Annuaires », « Rapports »…) — créé s'il manque, toujours DANS l'espace. */
export async function dossierDeLEspace(userId: string, chemin: string): Promise<{ spaceId: string; dossierId: string; chemin: string }> {
  const e = await espaceDAdam(userId);
  const parts = String(chemin || "Brouillons").split(/[\\/›>]+/).map((p) => p.trim().replace(/^\.+/, "")).filter(Boolean).slice(0, 4);
  if (!parts.length) parts.push("Brouillons");
  let parent: string | null = null;
  for (const p of parts) parent = await dossierDansEspace(userId, e.spaceId, parent, p.slice(0, 120));
  return { spaceId: e.spaceId, dossierId: parent!, chemin: `${NOM_ESPACE_ADAM} › ${parts.join(" › ")}` };
}

export interface FichierEcrit { nodeId: string; version: number; nom: string; chemin: string; nouveau: boolean }

/** Le nom gardé lisible et sûr pour le Drive. */
const nomSur = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 180) || "Document";

/**
 * DÉPOSER des octets (ou un contenu déjà stocké, `blobId`) dans l'espace d'Adam de la personne. Même nom dans le même
 * dossier → nouvelle version du même fichier (annulable : la précédente reste).
 */
export async function deposerDansLEspace(
  user: CurrentUser,
  f: { dossier: string; nom: string; mime: string; octets?: Buffer; blob?: { id: string; size: number; sha256?: string | null } },
): Promise<FichierEcrit> {
  const { dossierId, chemin } = await dossierDeLEspace(user.id, f.dossier);
  const nom = nomSur(f.nom);
  const existant = await prisma.driveNode.findFirst({ where: { type: "FILE", name: nom, parentId: dossierId, isTrashed: false }, select: { id: true } });
  const cible = existant ? { nodeId: existant.id } : { parentId: dossierId };
  const refus = await refusDepotDrive(user, cible);
  if (refus) throw new Error(refus.error);
  const blob = f.blob ? { blobId: f.blob.id, size: f.blob.size, sha256: f.blob.sha256 ?? null } : await (async () => { const b = await putBlob(f.octets ?? Buffer.alloc(0)); return { blobId: b.blobId, size: b.size, sha256: b.sha256 }; })();
  const r = await enregistrerFichierDrive(user, cible, { ...blob, mimeType: f.mime, name: nom });
  return { nodeId: r.id, version: r.version ?? 1, nom, chemin, nouveau: !existant };
}

/** La dernière version d'un fichier que la personne VOIT (droit du Drive) : son blob, pour une copie sans recopier les octets. */
export async function derniereVersionLisible(user: CurrentUser, nodeId: string): Promise<{ nom: string; mime: string | null; blob: { id: string; size: number }; version: number } | null> {
  if (!canViewDrive(await resolveDriveAccess(user, nodeId))) return null;
  const n = await prisma.driveNode.findFirst({
    where: { id: nodeId, type: "FILE", isTrashed: false },
    select: { name: true, mimeType: true, versions: { orderBy: { version: "desc" }, take: 1, select: { blobId: true, size: true, version: true } } },
  });
  const v = n?.versions[0];
  return n && v ? { nom: n.name, mime: n.mimeType, blob: { id: v.blobId, size: v.size }, version: v.version } : null;
}
