import { prisma } from "@/lib/prisma";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { getAdProEventsAsCalendar } from "@/modules/ad-pro/api";
import { notifyUser } from "@/lib/notify";
import { algiersYmd, algiersTime, formatAlgiers } from "@/lib/calendar-tz";
import { lienCalendrier } from "@/lib/chemins/espace";
import type { CalendarEventKind, CalendarInviteStatus, UserRole } from "@prisma/client";
import { sansBloquer } from "@/lib/journal";

// Réexport des helpers purs (fuseau d'Alger) pour les consommateurs serveur.
export {
  CALENDAR_KINDS, algiersTime, algiersInputToUtc,
  algiersTodayYmd, monthGrid,
} from "@/lib/calendar-tz";

/** `access` présent = session complète : les sources gardées par un module (Ad & Pro) s'y ajoutent. */
export interface SessionLike { id: string; role: UserRole; access?: SessionUser["access"] }

// ───────────────────────── DTO + requêtes ─────────────────────────

export interface CalendarInviteeDTO { userId: string; name: string; status: CalendarInviteStatus }

export interface CalendarEventDTO {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  kind: CalendarEventKind;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  color: string | null;
  meetLink: string | null;
  organizerId: string;
  organizerName: string;
  isOrganizer: boolean;
  myStatus: CalendarInviteStatus | null;
  ymd: string; // jour d'Alger du début (placement dans la grille)
  timeLabel: string; // heure d'Alger « HH:mm » (vide si journée entière)
  invitees: CalendarInviteeDTO[];
  /** Dernier jour d'Alger couvert, quand l'événement dure plusieurs jours (absent : un seul jour). */
  endYmd?: string;
  /**
   * L'événement n'est pas un rendez-vous de l'agenda : il est LU sur sa source (une demande Ad & Pro)
   * et se modifie là-bas. `label` = la nature affichée, `href` = la fiche de la demande.
   */
  source?: { kind: "AD_PRO"; label: string; href: string };
}

type EventRow = {
  id: string; title: string; description: string | null; location: string | null;
  kind: CalendarEventKind; startAt: Date; endAt: Date | null; allDay: boolean; color: string | null;
  meetLink: string | null; organizerId: string; organizer: { name: string };
  invitees: { userId: string; status: CalendarInviteStatus; user: { name: string } }[];
};

function toDTO(e: EventRow, userId: string): CalendarEventDTO {
  const mine = e.invitees.find((i) => i.userId === userId);
  return {
    id: e.id, title: e.title, description: e.description, location: e.location, kind: e.kind,
    startAt: e.startAt.toISOString(), endAt: e.endAt?.toISOString() ?? null, allDay: e.allDay,
    color: e.color, meetLink: e.meetLink, organizerId: e.organizerId, organizerName: e.organizer.name,
    isOrganizer: e.organizerId === userId, myStatus: mine?.status ?? null,
    ymd: algiersYmd(e.startAt), timeLabel: e.allDay ? "" : algiersTime(e.startAt),
    invitees: e.invitees.map((i) => ({ userId: i.userId, name: i.user.name, status: i.status })),
  };
}

/** Portée : un utilisateur voit les événements qu'il organise ou auxquels il est invité. */
function scopeWhere(user: SessionLike) {
  if (hasGlobalView(user.role)) return {};
  return { OR: [{ organizerId: user.id }, { invitees: { some: { userId: user.id } } }] };
}

const includeRel = { organizer: { select: { name: true } }, invitees: { include: { user: { select: { name: true } } } } };

/**
 * Réunions / appels PLANIFIÉS (module Meetings) projetés dans le calendrier : chacun
 * apparaît comme un événement « MEETING » pour l'organisateur et les participants,
 * avec le lien « Rejoindre » vers la page de la réunion.
 */
async function getScheduledMeetingsAsEvents(user: SessionLike, from: Date, to: Date): Promise<CalendarEventDTO[]> {
  const meetingScope = hasGlobalView(user.role)
    ? {}
    : { OR: [{ organizerId: user.id }, { participants: { some: { userId: user.id } } }] };
  const rows = await prisma.meeting.findMany({
    where: { AND: [meetingScope, { status: "SCHEDULED" as const }, { scheduledAt: { gte: from, lt: to } }] },
    include: { organizer: { select: { name: true } } },
    orderBy: { scheduledAt: "asc" },
  });
  return rows
    .filter((m) => m.scheduledAt)
    .map((m) => ({
      id: `meeting:${m.id}`,
      title: m.title,
      description: m.description,
      location: null,
      kind: "MEETING" as CalendarEventKind,
      startAt: m.scheduledAt!.toISOString(),
      endAt: null,
      allDay: false,
      color: null,
      meetLink: m.meetLink ?? `/meetings/${m.id}`,
      organizerId: m.organizerId,
      organizerName: m.organizer.name,
      isOrganizer: m.organizerId === user.id,
      myStatus: null,
      ymd: algiersYmd(m.scheduledAt!),
      timeLabel: algiersTime(m.scheduledAt!),
      invitees: [],
    }));
}

/** Événements visibles dans une fenêtre [from, to) (la grille affichée du mois) — rendez-vous,
 *  réunions planifiées et événements Ad & Pro (lus sur leur demande, `calendar-ad-pro.ts`). */
export async function getCalendarEvents(user: SessionLike, from: Date, to: Date): Promise<CalendarEventDTO[]> {
  const [rows, meetings, adPro] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { AND: [scopeWhere(user), { startAt: { gte: from, lt: to } }] },
      include: includeRel,
      orderBy: { startAt: "asc" },
    }),
    getScheduledMeetingsAsEvents(user, from, to),
    getAdProEventsAsCalendar(user, from, to),
  ]);
  return [...rows.map((r) => toDTO(r as EventRow, user.id)), ...meetings, ...adPro].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/** Prochains événements de l'utilisateur (agenda à droite) — réunions planifiées et Ad & Pro inclus. */
export async function getUpcomingEvents(user: SessionLike, limit = 8): Promise<CalendarEventDTO[]> {
  const from = new Date(Date.now() - 3600000);
  const horizon = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90);
  const [rows, meetings, adPro] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { AND: [scopeWhere(user), { startAt: { gte: from } }] },
      include: includeRel,
      orderBy: { startAt: "asc" },
      take: limit,
    }),
    getScheduledMeetingsAsEvents(user, from, horizon),
    // Un congrès commencé hier et qui finit demain est EN COURS : il reste en tête de liste.
    getAdProEventsAsCalendar(user, from, horizon),
  ]);
  return [...rows.map((r) => toDTO(r as EventRow, user.id)), ...meetings, ...adPro]
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, limit);
}

export interface NewCalendarEvent {
  title: string;
  description?: string | null;
  location?: string | null;
  kind?: CalendarEventKind;
  startAt: Date;
  endAt?: Date | null;
  allDay?: boolean;
  color?: string | null;
  meetLink?: string | null;
  inviteeIds?: string[];
}

/**
 * Crée un événement de calendrier (organisateur = userId) + invitations + notifications.
 * Réutilisé par l'action serveur et par l'outil de l'assistant IA.
 */
export async function createEventForUser(userId: string, data: NewCalendarEvent): Promise<string> {
  const invitees = Array.from(new Set((data.inviteeIds ?? []).filter((id) => id && id !== userId)));
  const event = await prisma.calendarEvent.create({
    data: {
      title: data.title,
      description: data.description ?? null,
      location: data.location ?? null,
      kind: data.kind ?? "APPOINTMENT",
      startAt: data.startAt,
      endAt: data.endAt ?? null,
      allDay: data.allDay ?? false,
      color: data.color ?? null,
      meetLink: data.meetLink ?? null,
      organizerId: userId,
      createdById: userId,
      invitees: invitees.length ? { create: invitees.map((id) => ({ userId: id })) } : undefined,
    },
  });

  const when = data.allDay ? formatAlgiers(data.startAt, { day: "2-digit", month: "long", year: "numeric" })
    : formatAlgiers(data.startAt, { weekday: "short", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" });
  await Promise.all(invitees.map((id) =>
    notifyUser({ userId: id, type: "ASSIGNMENT", title: "Invitation à un rendez-vous", body: `${data.title} — ${when}`, link: lienCalendrier(data.startAt) }).catch(sansBloquer("calendar.createEventForUser.notifyUser")),
  ));
  return event.id;
}
