"use server";

import { revalidatePath } from "next/cache";
import type { Confidentiality, DocumentCategory, EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { canAccessEntity, ENTITY_MODULE } from "@/lib/entity-access";
import { deleteFileByKey } from "@/lib/storage";
import { persistUploadedDocument } from "@/lib/documents";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { retirerCopiesDrive } from "@/lib/drive/document-mirror";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Téléversement d'UN document (action serveur historique, conservée pour compat).
 * Le téléversement en lot / dossier passe désormais par la route `/api/documents/upload`
 * (flux + parallèle). Les deux partagent `persistUploadedDocument`.
 */
export async function uploadDocument(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();

  const entityType = formData.get("entityType") as EntityType;
  const entityId = String(formData.get("entityId") ?? "");
  const category = (formData.get("category") as DocumentCategory) || "OTHER";
  const confidentiality = (formData.get("confidentiality") as Confidentiality) || "INTERNAL";
  const path = String(formData.get("path") ?? "");
  const stepKey = formData.get("stepKey") ? String(formData.get("stepKey")) : null;
  const file = formData.get("file") as File | null;

  if (!entityType || !entityId) return { ok: false, error: "Entité manquante." };
  if (!(await canAccessEntity(user, entityType, entityId, "UPLOAD"))) {
    return { ok: false, error: "Vous n'êtes pas autorisé à téléverser ici." };
  }
  if (!file || file.size === 0) return { ok: false, error: "Aucun fichier sélectionné." };

  const r = await persistUploadedDocument(user.id, { entityType, entityId, category, confidentiality, stepKey, file });
  if (!r.ok) return r;

  if (path) revalidatePath(path);
  return { ok: true };
}

/** Renomme un document (corriger une erreur de saisie). Mêmes droits que la suppression. */
export async function renameDocument(id: string, name: string, path?: string): Promise<ActionResult> {
  const user = await requireUser();
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Le nom ne peut pas être vide." };

  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return { ok: false, error: "Document introuvable." };

  const allowed =
    doc.uploadedById === user.id ||
    (await canAccessEntity(user, doc.entityType, doc.entityId, "UPDATE")) ||
    (await canAccessEntity(user, doc.entityType, doc.entityId, "DELETE"));
  if (!allowed) return { ok: false, error: "Modification non autorisée." };

  if (clean === doc.name) return { ok: true };

  await prisma.document.update({ where: { id }, data: { name: clean } });
  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: ENTITY_TYPE_LABELS[doc.entityType] ?? ENTITY_MODULE[doc.entityType],
    entityType: doc.entityType,
    entityId: doc.entityId,
    field: "name",
    oldValue: doc.name,
    newValue: clean,
    summary: `Document renommé « ${doc.name} » → « ${clean} »`,
  });

  if (path) revalidatePath(path);
  return { ok: true };
}

export async function deleteDocument(id: string, path?: string): Promise<ActionResult> {
  const user = await requireUser();
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return { ok: false, error: "Document introuvable." };

  // Peut supprimer : la personne qui l'a téléversé, OU l'admin / le responsable de l'objet
  // parent (quiconque peut l'éditer), OU un détenteur du droit de suppression du module.
  const allowed =
    doc.uploadedById === user.id ||
    (await canAccessEntity(user, doc.entityType, doc.entityId, "UPDATE")) ||
    (await canAccessEntity(user, doc.entityType, doc.entityId, "DELETE"));
  if (!allowed) {
    return { ok: false, error: "Suppression non autorisée." };
  }

  // Sa copie de « Mes documents importés » part à la corbeille avec elle (F2) — lue avant que le fichier soit libéré.
  await retirerCopiesDrive(doc);
  await prisma.document.delete({ where: { id } });
  if (doc.fileKey) await deleteFileByKey(doc.fileKey);

  await recordAudit({
    actorId: user.id,
    action: "DELETE",
    module: ENTITY_TYPE_LABELS[doc.entityType] ?? ENTITY_MODULE[doc.entityType],
    entityType: doc.entityType,
    entityId: doc.entityId,
    summary: `Document « ${doc.name} » supprimé`,
  });

  if (path) revalidatePath(path);
  return { ok: true };
}
