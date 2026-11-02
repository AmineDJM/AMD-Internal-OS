"use server";

import { revalidatePath } from "next/cache";
import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { sansBloquer } from "@/lib/journal";

/**
 * RAPPELS PERSONNELS « en un clic ». Un rappel appartient à son propriétaire (userId) ; à
 * l'échéance, un job planifié (scheduled.ts) le notifie. Peut être posé sur un objet (dossier,
 * demande…) via entityType/entityId + link, ou libre. Actions : créer, terminer, reporter, annuler.
 */

// Types d'entité acceptés pour un rappel (sinon : rappel libre). Évite un enum invalide en base.
const REMINDER_ENTITY_TYPES = new Set<EntityType>([
  "REGULATORY_PRODUCT", "REGULATORY_STEP", "ADMIN_REQUEST", "SPONSORING", "CONGRESS_INTERNATIONAL",
  "CONGRESS_NATIONAL", "TASK", "EXPENSE_ORDER", "VALIDATION_REQUEST", "SUPPORT_REQUEST", "DIRECTIVE",
  "DRIVER_MISSION", "MEDICAL_INFO_DECLARATION", "SALE", "BD_PROJECT", "BD_OPPORTUNITY",
]);
const asEntityType = (raw: string | null): EntityType | null =>
  raw && REMINDER_ENTITY_TYPES.has(raw as EntityType) ? (raw as EntityType) : null;

export async function createReminder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const title = (fdStr(formData, "title") ?? "").trim().slice(0, 200);
  if (!title) return { ok: false, error: "Objet du rappel manquant." };

  const raw = fdStr(formData, "remindAt");
  const remindAt = raw ? new Date(raw) : null;
  if (!remindAt || Number.isNaN(remindAt.getTime())) return { ok: false, error: "Date de rappel invalide." };
  if (remindAt.getTime() < Date.now() - 60_000) return { ok: false, error: "La date du rappel est déjà passée." };

  const created = await prisma.reminder.create({
    data: {
      userId: user.id,
      createdById: user.id,
      title,
      note: fdStr(formData, "note")?.slice(0, 1000) || null,
      link: fdStr(formData, "link")?.slice(0, 500) || null,
      entityType: asEntityType(fdStr(formData, "entityType")),
      entityId: fdStr(formData, "entityId")?.slice(0, 100) || null,
      remindAt,
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Rappels", entityType: "TASK", entityId: created.id, summary: `Rappel « ${title} » pour le ${remindAt.toLocaleString("fr-FR")}` }).catch(sansBloquer("reminder-actions.createReminder.recordAudit"));
  revalidatePath("/mon-espace");
  return { ok: true, id: created.id };
}

/** Charge un rappel dont l'utilisateur est propriétaire (ou super admin). */
async function ownedReminder(userId: string, id: string, isSuperAdmin: boolean) {
  const r = await prisma.reminder.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!r) return null;
  if (r.userId !== userId && !isSuperAdmin) return null;
  return r;
}

export async function completeReminder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Rappel introuvable." };
  const r = await ownedReminder(user.id, id, userCan(user, "ADMIN", "UPDATE"));
  if (!r) return { ok: false, error: "Rappel introuvable." };
  await prisma.reminder.update({ where: { id }, data: { status: "DONE" } });
  revalidatePath("/mon-espace");
  return { ok: true };
}

export async function cancelReminder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Rappel introuvable." };
  const r = await ownedReminder(user.id, id, userCan(user, "ADMIN", "UPDATE"));
  if (!r) return { ok: false, error: "Rappel introuvable." };
  await prisma.reminder.update({ where: { id }, data: { status: "CANCELLED" } });
  revalidatePath("/mon-espace");
  return { ok: true };
}

/** Reporte un rappel à une nouvelle date (ISO) ; par défaut +1 jour. Le remet en attente. */
export async function snoozeReminder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Rappel introuvable." };
  const r = await ownedReminder(user.id, id, userCan(user, "ADMIN", "UPDATE"));
  if (!r) return { ok: false, error: "Rappel introuvable." };
  const raw = fdStr(formData, "remindAt");
  const remindAt = raw ? new Date(raw) : new Date(Date.now() + 24 * 3600_000);
  if (Number.isNaN(remindAt.getTime())) return { ok: false, error: "Date invalide." };
  await prisma.reminder.update({ where: { id }, data: { remindAt, status: "PENDING", sentAt: null } });
  revalidatePath("/mon-espace");
  return { ok: true };
}
