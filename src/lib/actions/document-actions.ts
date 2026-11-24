"use server";

import { revalidatePath } from "next/cache";
import type { Confidentiality, DocumentCategory, EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { canAccessEntity, ENTITY_MODULE } from "@/lib/entity-access";
import { persistUploadedDocument } from "@/lib/documents";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { listerVersionsDocument } from "@/lib/document-versions";
import type { LigneVersionDocument } from "@/lib/document-versions-partage";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";

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

/**
 * SUPPRIMER UN DOCUMENT — vers la CORBEILLE, jamais pour de bon (audit du Drive, 24/11, points A5 et F8).
 *
 * Le déposant (ou qui gère l'objet) effaçait la ligne ET le fichier, sans retour possible — y compris la facture
 * d'un paiement déjà approuvé. La suppression passe désormais par le cœur réversible (type `DOCUMENT`) : la ligne
 * part à la corbeille, le fichier et ses versions restent au stockage jusqu'à la destruction réelle. Le refus
 * (pièce d'une demande de paiement, pièce d'une étape terminée) est jugé par le registre, pour l'écran ET Adam.
 */
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

  const r = await supprimerReversible("DOCUMENT", id, user.id, `Document « ${doc.name} » mis à la corbeille (${ENTITY_TYPE_LABELS[doc.entityType] ?? ENTITY_MODULE[doc.entityType]}) — restaurable depuis la corbeille`);
  if (!r.ok) return { ok: false, error: r.error };

  if (path) revalidatePath(path);
  return { ok: true };
}

/**
 * LES VERSIONS D'UN DOCUMENT — lues à l'ouverture du petit « Versions » de sa fiche. Mêmes droits que l'ouvrir :
 * qui lit le document lit son historique (chaque ligne se télécharge par `/api/documents/<id>?version=N`).
 */
export async function listerVersionsDuDocument(id: string): Promise<{ ok: true; versions: LigneVersionDocument[] } | { ok: false; error: string }> {
  // Une lecture : sous une vue ouverte, ce sont les droits de la personne visualisée (`enLecture`).
  const user = await enLecture(requireUser);
  const doc = await prisma.document.findUnique({ where: { id }, select: { id: true, entityType: true, entityId: true, stepKey: true } });
  if (!doc) return { ok: false, error: "Document introuvable." };
  if (!(await peutOuvrirDocument(user, doc))) return { ok: false, error: "Vous ne pouvez pas ouvrir ce document : demandez l'accès à son dossier." };
  return { ok: true, versions: await listerVersionsDocument(id) };
}
