import { getActionCenter, type ActionItem } from "@/lib/queries/action-center";
import { getCalendarEvents, type CalendarEventDTO } from "@/lib/calendar";
import { algiersTodayYmd } from "@/lib/calendar-tz";
import type { SessionUser } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";

/**
 * « AUJOURD'HUI » — l'écran d'accueil qui répond à une seule question : *que dois-je faire
 * maintenant ?*
 *
 * Le principe : on ne rajoute AUCUNE source de données. On relit le centre d'actions
 * (`getActionCenter`, déjà filtré par les droits de la personne) et l'agenda du jour, puis on
 * **ordonne** : une seule action mise en avant, quelques suivantes, le reste replié.
 * Trier n'est pas cosmétique — c'est ce qui remplace « 40 lignes » par « une décision ».
 */

/** Poids d'urgence : plus c'est haut, plus ça passe devant. */
function score(item: ActionItem, now: Date): number {
  let s = 0;
  if (item.deadline) {
    const days = (new Date(item.deadline).getTime() - now.getTime()) / 86_400_000;
    if (days < 0) s += 1000 + Math.min(-days, 30) * 10; // en retard : d'autant plus haut que ça traîne
    else if (days < 1) s += 700;                         // aujourd'hui
    else if (days <= 3) s += 400;                        // cette semaine
    else s += Math.max(0, 200 - days);
  }
  if (item.priority === "CRITICAL") s += 300;
  else if (item.priority === "HIGH") s += 150;
  // Une validation bloque le travail de quelqu'un d'autre : elle passe avant une tâche perso.
  if (item.kind === "validation") s += 250;
  else if (item.kind === "request" || item.kind === "payment" || item.kind === "regulatory") s += 120;
  return s;
}

export type TodayReason = "overdue" | "today" | "soon" | "blocking" | "priority" | "open";

export interface TodayItem extends ActionItem {
  /** Pourquoi cette ligne remonte — affiché tel quel, pour que le classement soit lisible. */
  reason: TodayReason;
  reasonLabel: string;
}

const REASONS: Record<TodayReason, string> = {
  overdue: "En retard",
  today: "Pour aujourd'hui",
  soon: "Dans les 3 jours",
  blocking: "Quelqu'un attend votre validation",
  priority: "Priorité haute",
  open: "En cours",
};

function reasonOf(item: ActionItem, now: Date): TodayReason {
  if (item.deadline) {
    const days = (new Date(item.deadline).getTime() - now.getTime()) / 86_400_000;
    if (days < 0) return "overdue";
    if (days < 1) return "today";
    if (days <= 3) return "soon";
  }
  if (item.kind === "validation") return "blocking";
  if (item.priority === "CRITICAL" || item.priority === "HIGH") return "priority";
  return "open";
}

export interface TodayView {
  /** L'action à faire MAINTENANT (null si la journée est vide). */
  focus: TodayItem | null;
  /** Les suivantes, déjà ordonnées (sans le focus). */
  next: TodayItem[];
  /** Ce qui reste, replié derrière « Tout voir ». */
  restCount: number;
  /** Rendez-vous du jour (fuseau d'Alger). */
  agenda: CalendarEventDTO[];
  counts: { total: number; overdue: number; validations: number; unread: number };
  /** Message d'accueil calé sur l'heure locale. */
  greeting: string;
}

function greetingFor(now: Date): string {
  const h = Number(new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", hour12: false, timeZone: "Africa/Algiers" }).format(now));
  if (h < 12) return "Bonjour";
  if (h < 18) return "Bon après-midi";
  return "Bonsoir";
}

/**
 * Classe les actions d'une personne, de la plus pressante à la moins pressante, et explique
 * chaque position. Fonction pure — c'est le cœur de l'écran, donc c'est ce qui est testé.
 */
export function rankToday(items: ActionItem[], now: Date): TodayItem[] {
  return items
    .map((i) => {
      const reason = reasonOf(i, now);
      return { ...i, reason, reasonLabel: REASONS[reason] };
    })
    .sort((a, b) => score(b, now) - score(a, now));
}

const NEXT_COUNT = 4;

export async function getToday(user: SessionUser): Promise<TodayView> {
  const now = new Date();

  // Agenda du jour : bornes de la journée d'Alger, converties en instants UTC.
  const ymd = algiersTodayYmd();
  const dayStart = new Date(`${ymd}T00:00:00.000Z`);
  const dayEnd = new Date(`${ymd}T23:59:59.999Z`);

  const [center, agenda] = await Promise.all([
    getActionCenter(user),
    getCalendarEvents(user, dayStart, dayEnd).catch(sansBloquer("today.getToday.getCalendarEvents", [] as CalendarEventDTO[])),
  ]);

  const ranked = rankToday(center.items, now);

  const focus = ranked[0] ?? null;
  const next = ranked.slice(1, 1 + NEXT_COUNT);

  return {
    focus,
    next,
    restCount: Math.max(0, ranked.length - 1 - next.length),
    // Un événement sur plusieurs jours (congrès Ad & Pro) est à l'agenda de CHACUN de ses jours.
    agenda: agenda.filter((e) => e.ymd <= ymd && (e.endYmd ?? e.ymd) >= ymd).sort((a, b) => a.startAt.localeCompare(b.startAt)),
    counts: {
      total: ranked.length,
      overdue: center.stats.overdue,
      validations: center.stats.validations,
      unread: center.stats.unread,
    },
    greeting: greetingFor(now),
  };
}
