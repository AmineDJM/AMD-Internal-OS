"use server";

import { revalidatePath } from "next/cache";
import type { FeedbackStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import {
  checkAttachment, rejectionMessage,
  MAX_ATTACHMENTS_PER_FEEDBACK,
} from "@/lib/files/attachment-policy";
import { canRemoveFeedbackAttachment } from "@/lib/feedback/access";
import { sansBloquer } from "@/lib/journal";

const STATUSES: FeedbackStatus[] = ["NEW", "SEEN", "IN_PROGRESS", "DONE"];

/**
 * LES PIÈCES JOINTES D'UN RETOUR — préparées AVANT d'écrire quoi que ce soit.
 *
 * L'ordre n'est pas un détail. On lit, on vérifie et on range les octets d'abord ; le retour
 * n'est créé qu'ensuite, et les lignes de pièces jointes en dernier. Ainsi :
 *   · un fichier refusé fait échouer la demande AVANT que le retour existe — pas de retour
 *     amputé de la pièce qui le rendait compréhensible ;
 *   · un échec APRÈS l'écriture des octets libère les blobs déposés — pas de contenu orphelin ;
 *   · aucune ligne de pièce jointe ne peut désigner un contenu qui n'a pas été écrit.
 */
async function prepareAttachments(files: File[]): Promise<
  | { ok: true; prepared: { blobId: string; name: string; mime: string; size: number }[] }
  | { ok: false; error: string }
> {
  if (files.length === 0) return { ok: true, prepared: [] };
  if (files.length > MAX_ATTACHMENTS_PER_FEEDBACK) {
    return { ok: false, error: rejectionMessage("too-many", "") };
  }

  const prepared: { blobId: string; name: string; mime: string; size: number }[] = [];
  /** Ce qui a déjà été écrit — à rendre si la suite échoue. */
  const rollback = async () => {
    for (const p of prepared) await releaseBlob(p.blobId).catch(sansBloquer("feedback-actions.rollback.releaseBlob"));
  };

  for (const f of files) {
    const bytes = Buffer.from(await f.arrayBuffer());
    // Le type ANNONCÉ par le navigateur n'entre dans aucune décision : ce sont les octets qui
    // décident (voir `files/attachment-policy`).
    const verdict = checkAttachment(f.name, bytes, f.type);
    if (!verdict.ok) {
      await rollback();
      return { ok: false, error: rejectionMessage(verdict.reason!, verdict.safeName) };
    }
    try {
      const { blobId } = await putBlob(bytes);
      prepared.push({ blobId, name: verdict.safeName, mime: verdict.mime, size: verdict.size });
    } catch {
      await rollback();
      return { ok: false, error: `Le dépôt de « ${verdict.safeName} » a échoué. Réessayez.` };
    }
  }
  return { ok: true, prepared };
}

/** N'importe quel utilisateur connecté peut envoyer un retour libre. */
export async function submitFeedback(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const message = fdStr(formData, "message");
  if (!message) return { ok: false, error: "Le message est obligatoire." };

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  // Les octets d'abord : un fichier refusé ne doit pas laisser derrière lui un retour orphelin.
  const att = await prepareAttachments(files);
  if (!att.ok) return { ok: false, error: att.error };

  let created: { id: string };
  try {
    // Le retour ET ses pièces dans UNE transaction : jamais de ligne de pièce jointe sans
    // retour, jamais de retour qui prétend avoir des pièces qu'il n'a pas.
    created = await prisma.$transaction(async (tx) => {
      const fb = await tx.feedback.create({
        data: { userId: user.id, message, module: fdStr(formData, "module") },
        select: { id: true },
      });
      if (att.prepared.length > 0) {
        await tx.feedbackAttachment.createMany({
          data: att.prepared.map((p) => ({ ...p, feedbackId: fb.id, uploadedById: user.id })),
        });
      }
      return fb;
    });
  } catch {
    // La transaction a échoué : les octets déjà écrits n'appartiennent à personne, on les rend.
    for (const p of att.prepared) await releaseBlob(p.blobId).catch(sansBloquer("feedback-actions.submitFeedback.releaseBlob"));
    return { ok: false, error: "L'enregistrement du retour a échoué. Rien n'a été conservé." };
  }

  await notifyRoles(["SUPER_ADMIN"], {
    type: "GENERIC",
    title: "Nouveau feedback",
    body: `${user.name} — ${message.slice(0, 80)}${att.prepared.length ? ` (${att.prepared.length} pièce(s))` : ""}`,
    link: "/admin/feedback",
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Feedback",
    entityType: "FEEDBACK", entityId: created.id,
    summary: `${message.slice(0, 80)}${att.prepared.length ? ` — ${att.prepared.length} pièce(s) jointe(s)` : ""}`,
  });
  revalidatePath("/feedback");
  revalidatePath("/admin/feedback");
  return { ok: true, id: created.id };
}

/** Réservé au Super Admin : marquer un feedback vu / en cours / traité. */
export async function updateFeedbackStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as FeedbackStatus | null;
  if (!id || !status || !STATUSES.includes(status)) return { ok: false, error: "Statut invalide." };

  const before = await prisma.feedback.findUnique({ where: { id }, select: { userId: true, adminNote: true } });
  const adminNote = fdStr(formData, "adminNote");
  await prisma.feedback.update({
    where: { id },
    data: { status, handledById: user.id, adminNote },
  });

  // Réponse de l'admin → notifie l'auteur (apparaît dans sa boîte de réception Feedback).
  if (adminNote && adminNote !== before?.adminNote && before?.userId && before.userId !== user.id) {
    await notifyUser({
      userId: before.userId,
      type: "GENERIC",
      title: "Réponse à votre feedback",
      body: adminNote.slice(0, 80),
      link: "/feedback",
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Feedback",
    entityType: "FEEDBACK", entityId: id, field: "status", newValue: status, summary: `Feedback → ${status}`,
  });
  revalidatePath("/admin/feedback");
  revalidatePath("/feedback");
  return { ok: true };
}

/**
 * Retire une pièce jointe d'un retour — et libère son contenu.
 *
 * `releaseBlob` décrémente le compteur de références : le contenu n'est réellement effacé que
 * s'il n'est plus utilisé ailleurs. Un même fichier déposé deux fois ne partage qu'un blob ;
 * supprimer l'une des deux pièces ne doit pas crever l'autre.
 */
export async function removeFeedbackAttachment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Pièce manquante." };

  const att = await prisma.feedbackAttachment.findUnique({
    where: { id },
    select: { id: true, blobId: true, name: true, feedbackId: true, feedback: { select: { userId: true } } },
  });
  if (!att) return { ok: false, error: "Pièce introuvable." };
  if (!canRemoveFeedbackAttachment(user, att.feedback)) return { ok: false, error: "Non autorisé." };

  await prisma.feedbackAttachment.delete({ where: { id } });
  await releaseBlob(att.blobId).catch(sansBloquer("feedback-actions.removeFeedbackAttachment.releaseBlob"));

  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Feedback",
    entityType: "FEEDBACK", entityId: att.feedbackId,
    summary: `Pièce jointe retirée — ${att.name}`,
  });
  revalidatePath("/feedback");
  revalidatePath("/admin/feedback");
  return { ok: true };
}
