"use server";

import { revalidatePath } from "next/cache";
import type { CalendarEventKind, CalendarInviteStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { algiersInputToUtc, createEventForUser, CALENDAR_KINDS } from "@/lib/calendar";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { lienCalendrier } from "@/lib/chemins/espace";
import { sansBloquer } from "@/lib/journal";

const INVITE_STATUSES: CalendarInviteStatus[] = ["INVITED", "ACCEPTED", "DECLINED", "TENTATIVE"];

function parseKind(v: string | null): CalendarEventKind {
  return v && (CALENDAR_KINDS as string[]).includes(v) ? (v as CalendarEventKind) : "APPOINTMENT";
}

export async function createCalendarEvent(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "WORKSPACE", "CREATE")) return { ok: false, error: "Non autorisé." };

  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Le titre est obligatoire." };
  const allDay = fdStr(formData, "allDay") === "on" || fdStr(formData, "allDay") === "true";
  const startRaw = fdStr(formData, "start");
  if (!startRaw) return { ok: false, error: "La date de début est obligatoire." };
  // En journée entière, la saisie peut être une date seule (YYYY-MM-DD) → minuit Alger.
  const startAt = algiersInputToUtc(allDay && startRaw.length === 10 ? `${startRaw}T00:00` : startRaw);
  if (!startAt) return { ok: false, error: "Date de début invalide." };
  const endRaw = fdStr(formData, "end");
  const endAt = endRaw ? algiersInputToUtc(endRaw.length === 10 ? `${endRaw}T00:00` : endRaw) : null;

  const inviteeIds = formData.getAll("inviteeIds").map((v) => String(v)).filter(Boolean);

  const id = await createEventForUser(user.id, {
    title,
    description: fdStr(formData, "description"),
    location: fdStr(formData, "location"),
    kind: parseKind(fdStr(formData, "kind")),
    startAt, endAt, allDay,
    color: fdStr(formData, "color"),
    meetLink: fdStr(formData, "meetLink"),
    inviteeIds,
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Espace de travail", summary: `Rendez-vous « ${title} »` });
  revalidatePath("/calendar");
  return { ok: true, id };
}

export async function updateCalendarEvent(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Événement introuvable." };
  const event = await prisma.calendarEvent.findUnique({ where: { id }, select: { organizerId: true } });
  if (!event) return { ok: false, error: "Événement introuvable." };
  if (event.organizerId !== user.id && !hasGlobalView(user.role)) return { ok: false, error: "Seul l'organisateur peut modifier ce rendez-vous." };

  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Le titre est obligatoire." };
  const allDay = fdStr(formData, "allDay") === "on" || fdStr(formData, "allDay") === "true";
  const startRaw = fdStr(formData, "start");
  if (!startRaw) return { ok: false, error: "La date de début est obligatoire." };
  const startAt = algiersInputToUtc(allDay && startRaw.length === 10 ? `${startRaw}T00:00` : startRaw);
  if (!startAt) return { ok: false, error: "Date de début invalide." };
  const endRaw = fdStr(formData, "end");
  const endAt = endRaw ? algiersInputToUtc(endRaw.length === 10 ? `${endRaw}T00:00` : endRaw) : null;
  const inviteeIds = Array.from(new Set(formData.getAll("inviteeIds").map((v) => String(v)).filter((v) => v && v !== user.id)));

  await prisma.calendarEvent.update({
    where: { id },
    data: {
      title, description: fdStr(formData, "description"), location: fdStr(formData, "location"),
      kind: parseKind(fdStr(formData, "kind")), startAt, endAt, allDay,
      color: fdStr(formData, "color"), meetLink: fdStr(formData, "meetLink"),
    },
  });

  // Réconcilie la liste des invités (ajoute les nouveaux, retire les absents).
  const existing = await prisma.calendarInvite.findMany({ where: { eventId: id }, select: { userId: true } });
  const existingIds = new Set(existing.map((e) => e.userId));
  const toAdd = inviteeIds.filter((uid) => !existingIds.has(uid));
  const toRemove = [...existingIds].filter((uid) => !inviteeIds.includes(uid));
  if (toAdd.length) {
    await prisma.calendarInvite.createMany({ data: toAdd.map((uid) => ({ eventId: id, userId: uid })), skipDuplicates: true });
    await Promise.all(toAdd.map((uid) => notifyUser({ userId: uid, type: "ASSIGNMENT", title: "Invitation à un rendez-vous", body: title, link: lienCalendrier(startAt) }).catch(sansBloquer("calendar-actions.updateCalendarEvent.notifyUser"))));
  }
  if (toRemove.length) await prisma.calendarInvite.deleteMany({ where: { eventId: id, userId: { in: toRemove } } });

  revalidatePath("/calendar");
  return { ok: true, id };
}

export async function deleteCalendarEvent(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const event = await prisma.calendarEvent.findUnique({ where: { id }, select: { organizerId: true, title: true } });
  if (!event) return { ok: false, error: "Événement introuvable." };
  if (event.organizerId !== user.id && !hasGlobalView(user.role)) return { ok: false, error: "Seul l'organisateur peut supprimer ce rendez-vous." };
  await prisma.calendarEvent.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Espace de travail", summary: `Rendez-vous supprimé — ${event.title}` });
  revalidatePath("/calendar");
  return { ok: true };
}

/** La personne invitée répond à l'invitation (accepte / refuse / peut-être). */
export async function respondToInvite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const eventId = fdStr(formData, "eventId");
  const statusRaw = fdStr(formData, "status");
  if (!eventId || !statusRaw || !INVITE_STATUSES.includes(statusRaw as CalendarInviteStatus)) return { ok: false, error: "Paramètres invalides." };
  const invite = await prisma.calendarInvite.findUnique({ where: { eventId_userId: { eventId, userId: user.id } }, select: { id: true } });
  if (!invite) return { ok: false, error: "Invitation introuvable." };
  await prisma.calendarInvite.update({ where: { id: invite.id }, data: { status: statusRaw as CalendarInviteStatus, respondedAt: new Date() } });
  revalidatePath("/calendar");
  return { ok: true };
}
