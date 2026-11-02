import { canManageDriveSpace, canViewDriveSpace, type SessionUser } from "./rbac";
import { prisma } from "./prisma";

export type DriveAccessLevel = "NONE" | "VIEW" | "EDIT";

/**
 * Effective access to a Drive node. A Super Admin manages everything; a user with
 * DRIVE scope = ALL (admin-granted, e.g. Direction) gets org-wide read; otherwise
 * access comes from ownership or a share — inherited down the folder tree.
 *
 * Un nœud rattaché à une CATÉGORIE partagée (spaceId) tire d'abord son niveau de la
 * catégorie : gestionnaire → ÉDITION, lecteur → CONSULTATION. Un partage nominatif explicite
 * peut ensuite rehausser ce niveau (la boucle ownership/partage ci-dessous).
 */
export async function resolveDriveAccess(user: SessionUser, nodeId: string): Promise<DriveAccessLevel> {
  if (user.role === "SUPER_ADMIN") return "EDIT";
  let best: DriveAccessLevel = user.access.modules.get("DRIVE")?.scope === "ALL" ? "VIEW" : "NONE";

  const withSpace = await prisma.driveNode.findUnique({
    where: { id: nodeId },
    select: { space: { select: { accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true } } },
  });
  if (withSpace?.space) {
    if (canManageDriveSpace(user, withSpace.space)) return "EDIT";
    if (canViewDriveSpace(user, withSpace.space)) best = "VIEW";
  }

  let currentId: string | null = nodeId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const node: { ownerId: string | null; parentId: string | null; shares: { access: string }[] } | null =
      await prisma.driveNode.findUnique({
        where: { id: currentId },
        select: { ownerId: true, parentId: true, shares: { where: { userId: user.id }, select: { access: true } } },
      });
    if (!node) break;
    if (node.ownerId === user.id) return "EDIT";
    for (const s of node.shares) {
      if (s.access === "EDIT") return "EDIT";
      best = "VIEW";
    }
    currentId = node.parentId;
  }
  if (best === "NONE" && seen.size > 0 && (await partageParMessagerie(user.id, [...seen]))) best = "VIEW";
  return best;
}

/**
 * LU DANS UNE CONVERSATION DONT ON EST MEMBRE — le fichier (ou un dossier parent) y a été joint.
 *
 * L'envoi accorde un partage nominatif aux membres PRÉSENTS (`grantDriveRefAccess`) ; quiconque
 * entrait ensuite — ajouté à un groupe, canal rejoint, retour après départ — voyait la pièce dans
 * le fil et recevait un refus en l'ouvrant (Direction, 27/10). Le droit se lit donc aussi ici, au
 * moment de l'ouverture : membre actif d'une conversation où un message non retiré joint ce nœud.
 * Quitter la conversation, ou retirer le message, referme cette porte. La référence elle-même a été
 * validée contre les droits de l'expéditeur à l'envoi (`parseDriveRefs`) : c'est son geste de partage.
 */
async function partageParMessagerie(userId: string, nodeIds: string[]): Promise<boolean> {
  const piece = await prisma.messageAttachment.findFirst({
    where: {
      driveNodeId: { in: nodeIds },
      message: { deletedAt: null, conversation: { members: { some: { userId, leftAt: null } } } },
    },
    select: { id: true },
  });
  return piece !== null;
}

export const canEditDrive = (level: DriveAccessLevel) => level === "EDIT";
export const canViewDrive = (level: DriveAccessLevel) => level === "VIEW" || level === "EDIT";

/**
 * spaceId EFFECTIF d'un NOUVEAU nœud : hérité du parent s'il y en a un (invariant « tout le
 * sous-arbre d'une catégorie porte le même spaceId »), sinon le spaceId explicite (création à la
 * racine d'une catégorie), sinon null (Drive personnel).
 */
export async function effectiveSpaceId(parentId: string | null, explicitSpaceId: string | null): Promise<string | null> {
  if (parentId) {
    const p = await prisma.driveNode.findUnique({ where: { id: parentId }, select: { spaceId: true } });
    return p?.spaceId ?? null;
  }
  return explicitSpaceId ?? null;
}

/** Peut créer/déposer à la RACINE d'une catégorie (spaceId sans parent) : réservé aux gestionnaires. */
export async function canCreateInSpace(user: SessionUser, spaceId: string): Promise<boolean> {
  const s = await prisma.driveSpace.findUnique({
    where: { id: spaceId },
    select: { accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true },
  });
  return s ? canManageDriveSpace(user, s) : false;
}

/** Breadcrumb from root to the given node (inclusive). */
export async function driveBreadcrumb(nodeId: string | null): Promise<{ id: string; name: string }[]> {
  const crumbs: { id: string; name: string }[] = [];
  let currentId = nodeId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const node = await prisma.driveNode.findUnique({ where: { id: currentId }, select: { id: true, name: true, parentId: true } });
    if (!node) break;
    crumbs.unshift({ id: node.id, name: node.name });
    currentId = node.parentId;
  }
  return crumbs;
}

/** Coarse file kind for choosing a viewer. */
export function fileKind(mime: string | null | undefined, name: string): "pdf" | "image" | "video" | "audio" | "text" | "office" | "other" {
  const m = (mime ?? "").toLowerCase();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (m.startsWith("video/") || ["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (m.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "office";
  if (m.startsWith("text/") || ["txt", "csv", "md", "json", "log"].includes(ext)) return "text";
  return "other";
}
