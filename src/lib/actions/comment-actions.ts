"use server";

import { revalidatePath } from "next/cache";
import { requireUser, type CurrentUser } from "@/lib/session";
import { canModerateEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { supprimerPiecesDuMessage } from "@/lib/fil-pieces-db";

/** Auteur du commentaire, ou personne pouvant éditer l'objet parent (admin / responsable). */
async function canManageComment(user: CurrentUser, comment: { authorId: string | null; entityType: import("@prisma/client").EntityType; entityId: string }): Promise<boolean> {
  if (comment.authorId && comment.authorId === user.id) return true;
  return canModerateEntity(user, comment.entityType, comment.entityId);
}

/** Modifie un commentaire (auteur, admin ou responsable de l'objet). */
export async function updateComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = fdStr(formData, "body");
  if (!id) return { ok: false, error: "Commentaire introuvable." };
  if (!body) return { ok: false, error: "Le commentaire ne peut pas être vide." };

  const comment = await prisma.comment.findUnique({ where: { id }, select: { authorId: true, entityType: true, entityId: true } });
  if (!comment) return { ok: false, error: "Commentaire introuvable." };
  if (!(await canManageComment(user, comment))) return { ok: false, error: "Modification non autorisée." };

  await prisma.comment.update({ where: { id }, data: { body, editedAt: new Date() } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: ENTITY_TYPE_LABELS[comment.entityType] ?? "Commentaires", entityType: comment.entityType, entityId: comment.entityId, summary: "Commentaire modifié" });
  const path = fdStr(formData, "path");
  if (path) revalidatePath(path);
  return { ok: true };
}

/** Supprime un commentaire (auteur, admin ou responsable de l'objet). */
export async function deleteComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Commentaire introuvable." };

  const comment = await prisma.comment.findUnique({ where: { id }, select: { authorId: true, entityType: true, entityId: true } });
  if (!comment) return { ok: false, error: "Commentaire introuvable." };
  if (!(await canManageComment(user, comment))) return { ok: false, error: "Suppression non autorisée." };

  await prisma.comment.delete({ where: { id } });
  // LES PIÈCES JOINTES DU MESSAGE PARTENT AVEC LUI (`lib/fil-pieces`) — l'écran l'a dit dans sa question.
  const n = await supprimerPiecesDuMessage({ id, entityType: comment.entityType, entityId: comment.entityId });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: ENTITY_TYPE_LABELS[comment.entityType] ?? "Commentaires", entityType: comment.entityType, entityId: comment.entityId,
    summary: n > 0 ? `Commentaire supprimé, avec ${n} pièce${n > 1 ? "s" : ""} jointe${n > 1 ? "s" : ""}` : "Commentaire supprimé",
  });
  const path = fdStr(formData, "path");
  if (path) revalidatePath(path);
  return { ok: true };
}
