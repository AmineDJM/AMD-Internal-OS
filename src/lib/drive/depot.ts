import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { resolveDriveAccess, effectiveSpaceId, canCreateInSpace } from "@/lib/drive";
import { recordAudit } from "@/lib/audit";
import type { SessionUser } from "@/lib/rbac";
import { signalerFichierDrive } from "@/lib/enrichissement/signalement";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";

/**
 * DÉPOSER UN FICHIER DANS LE DRIVE — la porte et l'écriture, une seule fois pour les deux chemins.
 *
 * Le chemin habituel (le serveur reçoit le fichier) et le chemin DIRECT (le navigateur écrit
 * dans le bucket, le serveur finalise) doivent répondre la même chose à « ai-je le droit ? » et
 * créer le même fichier. Deux copies de cette règle finiraient par ne plus accorder la même chose
 * (§118.5) : on la sort ici, et les deux routes l'appellent.
 */

export interface CibleDepot {
  /** Nouvelle VERSION de ce fichier. */
  nodeId?: string | null;
  /** Nouveau fichier dans ce dossier. */
  parentId?: string | null;
  /** Nouveau fichier à la racine de cette catégorie. */
  spaceId?: string | null;
  category?: string | null;
  viewers?: string[];
  editors?: string[];
}

/**
 * Autorisation d'écriture. Un accès ÉDITEUR explicite sur la cible suffit, même sans le droit
 * module « Téléverser » :
 *  - nouvelle version d'un fichier → éditeur sur CE fichier ;
 *  - nouveau fichier dans un dossier → éditeur sur CE dossier ;
 *  - nouveau fichier à la racine d'une CATÉGORIE → gestionnaire de la catégorie ;
 *  - nouveau fichier à la racine (espace perso) → droit module « Téléverser ».
 * Rend le refus (et son code HTTP), ou `null`.
 */
export async function refusDepotDrive(user: SessionUser, cible: CibleDepot): Promise<{ error: string; status: number } | null> {
  if (cible.nodeId) {
    if ((await resolveDriveAccess(user, cible.nodeId)) !== "EDIT") return { error: "Non autorisé.", status: 403 };
  } else if (cible.parentId) {
    if ((await resolveDriveAccess(user, cible.parentId)) !== "EDIT") return { error: "Dossier non autorisé.", status: 403 };
  } else if (cible.spaceId) {
    if (!(await canCreateInSpace(user, cible.spaceId))) return { error: "Catégorie non autorisée.", status: 403 };
  } else if (!userCan(user, "DRIVE", "UPLOAD")) {
    return { error: "Non autorisé.", status: 403 };
  }
  return null;
}

/**
 * Inscrit le fichier (nouvelle version, ou nouveau nœud + partages) pour un blob DÉJÀ écrit.
 * Rend l'identifiant du nœud et, pour une version, son numéro.
 */
export async function enregistrerFichierDrive(
  user: SessionUser,
  cible: CibleDepot,
  fichier: {
    blobId: string; size: number; mimeType: string; name: string;
    /** L'empreinte du contenu quand l'appelant l'a (`putBlob().sha256`) ; sinon relue sur le blob. */
    sha256?: string | null;
  },
): Promise<{ id: string; version?: number }> {
  const { blobId, size, mimeType, name } = fichier;
  // La pièce nourrit les fiches (refonte, lot V2-A), une fois le fichier inscrit — interrupteur fermé : rien.
  // Et elle entre à la bibliothèque (J1) : registre, clé d'accès du nœud, file d'ingestion. Ni l'un ni l'autre ne lève.
  const signaler = async (nodeId: string, version: number | null) => {
    await signalerFichierDrive({ nodeId, version, blobId, sha256: fichier.sha256 ?? null, nom: name, mime: mimeType, taille: size, deposeParId: user.id });
    await inscrireFichierDrive({ nodeId, version, blobId, sha256: fichier.sha256 ?? null, nom: name, mime: mimeType, taille: size, deposeParId: user.id });
  };
  if (cible.nodeId) {
    const nodeId = cible.nodeId;
    const last = await prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;
    await prisma.fileVersion.create({ data: { nodeId, blobId, version, size, mimeType, createdById: user.id } });
    await prisma.driveNode.update({ where: { id: nodeId }, data: { size, mimeType } });
    await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: nodeId, summary: `Nouvelle version (v${version})` });
    await signaler(nodeId, version);
    return { id: nodeId, version };
  }

  const category = (cible.category ?? "").trim() || null;
  const parentId = cible.parentId ?? null;
  const effSpaceId = await effectiveSpaceId(parentId, cible.spaceId ?? null);
  const node = await prisma.driveNode.create({
    data: {
      name, type: "FILE", parentId, spaceId: effSpaceId, ownerId: user.id, mimeType, size, category, createdById: user.id,
      versions: { create: { blobId, version: 1, size, mimeType, createdById: user.id } },
    },
    select: { id: true },
  });

  // Crée les partages (EDIT prioritaire sur VIEW ; on ignore l'auteur et les IDs invalides).
  const editorIds = new Set((cible.editors ?? []).filter((id) => id && id !== user.id));
  const viewerIds = new Set((cible.viewers ?? []).filter((id) => id && id !== user.id && !editorIds.has(id)));
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

  await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: node.id, summary: `Fichier « ${name} »${category ? ` · ${category}` : ""}${ids.length ? ` · partagé (${ids.length})` : ""}` });
  await signaler(node.id, null);
  return { id: node.id };
}
