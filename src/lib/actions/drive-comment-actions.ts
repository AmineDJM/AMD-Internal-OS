"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/utils";
import { resolveDriveAccess } from "@/lib/drive";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * Le fil de commentaires d'un nœud — lu à l'ouverture du panneau « Commentaires », pas avec la page :
 * ouvrir un fichier ne doit rien attendre qui ne s'affiche pas. Supprimer : l'auteur ou un éditeur
 * (règle de `deleteDriveComment`, rappelée ici pour n'afficher que la corbeille utilisable).
 */
export async function listDriveComments(
  nodeId: string,
): Promise<{ ok: boolean; error?: string; comments?: { id: string; author: string; body: string; createdLabel: string; canDelete: boolean }[] }> {
  const user = await enLecture(requireUser);
  const level = await resolveDriveAccess(user, nodeId);
  if (level === "NONE") return { ok: false, error: "Non autorisé." };
  const rows = await prisma.driveComment.findMany({
    where: { nodeId }, orderBy: { createdAt: "asc" },
    select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { name: true } } },
  });
  return {
    ok: true,
    comments: rows.map((c) => ({
      id: c.id,
      author: c.author?.name ?? "—",
      body: c.body,
      createdLabel: formatDateTime(c.createdAt),
      canDelete: c.authorId === user.id || level === "EDIT" || user.role === "SUPER_ADMIN",
    })),
  };
}

/**
 * Poste un commentaire sur un nœud du Drive (fichier ou dossier). Toute personne
 * AYANT ACCÈS au nœud (lecture ou édition) peut commenter — utile pour tracer le
 * motif d'une modification. Chaque document a son propre fil.
 */
export async function postDriveComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nodeId = fdStr(formData, "nodeId");
  const body = fdStr(formData, "body");
  if (!nodeId) return { ok: false, error: "Document introuvable." };
  if (!body) return { ok: false, error: "Le commentaire est vide." };
  if ((await resolveDriveAccess(user, nodeId)) === "NONE") return { ok: false, error: "Non autorisé." };

  await prisma.driveComment.create({ data: { nodeId, authorId: user.id, body } });

  // Prévient le propriétaire du document qu'un commentaire a été laissé (s'il n'est pas l'auteur).
  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true, ownerId: true } });
  if (node?.ownerId && node.ownerId !== user.id) {
    await notifyUser({
      userId: node.ownerId, type: "GENERIC",
      title: `Commentaire — ${node.name}`, body: body.slice(0, 140), link: `/drive/${nodeId}`,
    }).catch(() => {});
  }
  revalidatePath(`/drive/${nodeId}`);
  return { ok: true };
}

/**
 * Supprime un commentaire : son AUTEUR, un ÉDITEUR du nœud, ou le Super Admin.
 */
export async function deleteDriveComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Commentaire introuvable." };
  const comment = await prisma.driveComment.findUnique({ where: { id }, select: { authorId: true, nodeId: true } });
  if (!comment) return { ok: false, error: "Commentaire introuvable." };
  const isAuthor = comment.authorId === user.id;
  const canModerate = user.role === "SUPER_ADMIN" || (await resolveDriveAccess(user, comment.nodeId)) === "EDIT";
  if (!isAuthor && !canModerate) return { ok: false, error: "Suppression non autorisée." };
  await prisma.driveComment.delete({ where: { id } });
  revalidatePath(`/drive/${comment.nodeId}`);
  return { ok: true };
}
