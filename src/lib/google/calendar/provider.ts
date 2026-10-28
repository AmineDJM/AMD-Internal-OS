import { CALENDAR_BASE } from "../config";
import { googleJson } from "../client";

/**
 * L'AGENDA GOOGLE — lire, proposer, créer, décaler, annuler.
 *
 * Le fuseau est explicite partout (`Africa/Algiers`) : un créneau proposé dans le mauvais fuseau
 * fait rater une réunion, et l'erreur ne se voit qu'au moment où personne n'arrive. Google
 * accepte des dates flottantes ; on ne s'en sert jamais.
 *
 * Les mutations d'agenda suivent les règles de confirmation DÉJÀ en place pour l'agenda interne
 * du Chief : on n'ajoute pas une approbation supplémentaire sous prétexte que c'est Google —
 * déplacer une réunion n'est pas écrire au monde extérieur au nom de l'entreprise.
 */

export const ALGIERS_TZ = "Africa/Algiers";

export interface GCalAttendee {
  email: string;
  displayName?: string | null;
  responseStatus?: string | null;
  optional?: boolean;
}

export interface GCalEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  attendees: GCalAttendee[];
  organizer: string | null;
  meetLink: string | null;
  htmlLink: string | null;
  status: string;
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; optional?: boolean }[];
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
}

function normalize(raw: RawEvent): GCalEvent {
  const meet =
    raw.hangoutLink ??
    raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null;
  return {
    id: String(raw.id ?? ""),
    summary: raw.summary ?? "(sans titre)",
    description: raw.description ?? null,
    location: raw.location ?? null,
    start: raw.start?.dateTime ?? raw.start?.date ?? null,
    end: raw.end?.dateTime ?? raw.end?.date ?? null,
    allDay: Boolean(raw.start?.date && !raw.start?.dateTime),
    attendees: (raw.attendees ?? []).map((a) => ({
      email: (a.email ?? "").toLowerCase(),
      displayName: a.displayName ?? null,
      responseStatus: a.responseStatus ?? null,
      optional: Boolean(a.optional),
    })),
    organizer: raw.organizer?.email?.toLowerCase() ?? null,
    meetLink: meet,
    htmlLink: raw.htmlLink ?? null,
    status: raw.status ?? "confirmed",
  };
}

export async function listEvents(accessToken: string, opts: {
  timeMin?: Date; timeMax?: Date; q?: string; maxResults?: number; calendarId?: string;
} = {}): Promise<GCalEvent[]> {
  const cal = encodeURIComponent(opts.calendarId ?? "primary");
  const res = await googleJson<{ items?: RawEvent[] }>({
    url: `${CALENDAR_BASE}/calendars/${cal}/events`,
    accessToken,
    query: {
      timeMin: (opts.timeMin ?? new Date()).toISOString(),
      timeMax: opts.timeMax?.toISOString(),
      q: opts.q,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: opts.maxResults ?? 25,
      timeZone: ALGIERS_TZ,
    },
  });
  return (res.items ?? []).map(normalize);
}

export interface BusySlot { start: Date; end: Date }

/** Les plages OCCUPÉES — la seule base honnête pour proposer un créneau. */
export async function freeBusy(accessToken: string, opts: { timeMin: Date; timeMax: Date; calendars?: string[] }): Promise<BusySlot[]> {
  const res = await googleJson<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>({
    method: "POST",
    url: `${CALENDAR_BASE}/freeBusy`,
    accessToken,
    body: {
      timeMin: opts.timeMin.toISOString(),
      timeMax: opts.timeMax.toISOString(),
      timeZone: ALGIERS_TZ,
      items: (opts.calendars ?? ["primary"]).map((id) => ({ id })),
    },
  });
  const out: BusySlot[] = [];
  for (const cal of Object.values(res.calendars ?? {})) {
    for (const b of cal.busy ?? []) out.push({ start: new Date(b.start), end: new Date(b.end) });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Les créneaux LIBRES d'une durée donnée, dans les heures ouvrables.
 *
 * Fonction PURE (les plages occupées sont fournies) : la recherche de créneau se teste sans
 * réseau, et c'est important — c'est le calcul le plus facile à faire faux d'une heure.
 */
export function findFreeSlots(
  busy: BusySlot[],
  opts: { from: Date; to: Date; durationMin: number; workdayStartHour?: number; workdayEndHour?: number; limit?: number },
): { start: Date; end: Date }[] {
  const startHour = opts.workdayStartHour ?? 8;
  const endHour = opts.workdayEndHour ?? 17;
  const durationMs = opts.durationMin * 60_000;
  const out: { start: Date; end: Date }[] = [];
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());

  const cursor = new Date(opts.from);
  cursor.setSeconds(0, 0);
  while (cursor < opts.to && out.length < (opts.limit ?? 5)) {
    const day = new Date(cursor);
    const dayStart = new Date(day); dayStart.setHours(startHour, 0, 0, 0);
    const dayEnd = new Date(day); dayEnd.setHours(endHour, 0, 0, 0);
    let slotStart = cursor < dayStart ? new Date(dayStart) : new Date(cursor);

    // Week-end : on saute. Proposer un créneau un vendredi après-midi en Algérie serait une erreur
    // de contexte, pas un détail — le week-end y est vendredi/samedi.
    const dow = slotStart.getDay();
    if (dow === 5 || dow === 6) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(startHour, 0, 0, 0);
      continue;
    }

    while (slotStart.getTime() + durationMs <= dayEnd.getTime() && out.length < (opts.limit ?? 5)) {
      const slotEnd = new Date(slotStart.getTime() + durationMs);
      const clash = sorted.find((b) => b.start < slotEnd && b.end > slotStart);
      if (!clash) {
        out.push({ start: new Date(slotStart), end: slotEnd });
        slotStart = new Date(slotEnd);
      } else {
        slotStart = new Date(Math.max(clash.end.getTime(), slotStart.getTime() + 15 * 60_000));
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(startHour, 0, 0, 0);
  }
  return out;
}
