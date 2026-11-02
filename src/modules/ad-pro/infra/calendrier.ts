import { prisma } from "@/lib/prisma";
import { platformScope } from "@/lib/company";
import { userCan, scopeCongressIntl, scopeCongressNational, type SessionUser } from "@/lib/rbac";
import { algiersYmd, algiersTime } from "@/lib/calendar-tz";
import { EVENT_TYPE, NATIONAL_EVENT_TYPE } from "@/lib/labels";
import type { CalendarEventDTO } from "@/lib/calendar";
import type { UserRole } from "@prisma/client";

/**
 * LES ÉVÉNEMENTS AD & PRO DANS L'AGENDA — congrès, symposiums, tables rondes, staffs, journées…
 *
 * Ils sont LUS sur leur demande, jamais recopiés dans `CalendarEvent` : une copie ne suivrait ni
 * une date déplacée, ni une annulation, ni une suppression. Ici, l'agenda relit la source à chaque
 * affichage — la date modifiée suit, la demande annulée, refusée ou supprimée disparaît.
 *
 * LA PORTÉE EST CELLE DE LA LISTE « Toutes les demandes » (`getAdProRequests`) : le module de la
 * nature en lecture, sa portée de ligne (un délégué ne voit que ses congrès) et l'entité choisie
 * dans l'en-tête. L'agenda ne montre donc jamais une demande que la personne ne verrait pas dans
 * Ad & Pro — et la fiche, plus large que la liste (§118.184), s'ouvre toujours depuis le lien.
 *
 * Trois natures portent une date : prise en charge internationale, prise en charge nationale,
 * événement. Le sponsoring et les « autres demandes » n'en ont pas : rien à placer.
 */

export const AD_PRO_AGENDA_COLOR = "#c026d3";

type SessionLike = { id: string; role: UserRole; access?: SessionUser["access"] };

/** Sans matrice de droits (appel interne qui n'a que l'identifiant), on ne montre RIEN. */
function sessionComplete(user: SessionLike): user is SessionUser {
  return Boolean(user.access);
}

export type NatureAdProDatee = "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENT";

const FICHE: Record<NatureAdProDatee, string> = {
  CONGRESS_INTERNATIONAL: "/congress-international",
  CONGRESS_NATIONAL: "/congress-national",
  EVENT: "/events",
};

export interface DemandeAdProDatee {
  nature: NatureAdProDatee;
  id: string;
  intitule: string;
  type: string; // libellé de la nature (« Symposium · national »)
  debut: Date;
  fin: Date | null;
  lieu: (string | null | undefined)[];
  demandeurId: string | null;
  demandeur: string | null;
}

/** Une date saisie sans heure (champ « date ») arrive à minuit UTC — ou à minuit d'Alger. */
function sansHeure(d: Date): boolean {
  return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
    && (d.getUTCHours() === 0 || algiersTime(d) === "00:00");
}

/** Une demande datée → une ligne d'agenda. Pure : la règle des jours se teste sans base. */
export function projeterDemandeAdPro(d: DemandeAdProDatee): CalendarEventDTO {
  const fin = d.fin && d.fin.getTime() > d.debut.getTime() ? d.fin : null;
  const allDay = sansHeure(d.debut) && (!fin || sansHeure(fin));
  const ymd = algiersYmd(d.debut);
  const endYmd = fin ? algiersYmd(fin) : ymd;
  const lieu = [...new Set(d.lieu.map((l) => l?.trim()).filter((l): l is string => Boolean(l)))].join(", ");
  return {
    id: `adpro:${d.nature}:${d.id}`,
    title: d.intitule,
    description: null,
    location: lieu || null,
    kind: "OTHER",
    startAt: d.debut.toISOString(),
    endAt: fin?.toISOString() ?? null,
    allDay,
    color: AD_PRO_AGENDA_COLOR,
    meetLink: null,
    organizerId: d.demandeurId ?? "",
    organizerName: d.demandeur ?? "—",
    // Jamais « organisateur » : l'agenda ne modifie ni ne supprime une demande Ad & Pro.
    isOrganizer: false,
    myStatus: null,
    ymd,
    timeLabel: allDay ? "" : algiersTime(d.debut),
    invitees: [],
    ...(endYmd !== ymd ? { endYmd } : {}),
    source: { kind: "AD_PRO", label: `Ad & Pro · ${d.type}`, href: `${FICHE[d.nature]}/${d.id}` },
  };
}

/** L'événement touche-t-il au moins un jour de la fenêtre (jours d'Alger, bornes incluses) ? */
export function toucheLaFenetre(e: Pick<CalendarEventDTO, "ymd" | "endYmd">, debutYmd: string, finYmd: string): boolean {
  return e.ymd <= finYmd && (e.endYmd ?? e.ymd) >= debutYmd;
}

const PLAFOND = 500;
const ECARTEES = ["REJECTED", "CANCELLED"] as const;

/**
 * Les demandes Ad & Pro datées qui touchent la fenêtre [from, to) — annulées et refusées exclues.
 */
export async function getAdProEventsAsCalendar(user: SessionLike, from: Date, to: Date): Promise<CalendarEventDTO[]> {
  if (!sessionComplete(user)) return [];
  const can = (m: "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENTS") => userCan(user, m, "VIEW");
  const [voitIntl, voitNat, voitEvt] = [can("CONGRESS_INTERNATIONAL"), can("CONGRESS_NATIONAL"), can("EVENTS")];
  if (!voitIntl && !voitNat && !voitEvt) return [];

  const scope = await platformScope(user.id);
  // Une journée entière est rangée à minuit UTC, une heure APRÈS le minuit d'Alger qui ouvre la
  // fenêtre : un jour de marge à la lecture, puis le tri exact sur les jours d'Alger.
  const marge = new Date(from.getTime() - 86400000);

  const [intl, nat, evts] = await Promise.all([
    voitIntl
      ? prisma.congressInternational.findMany({
          where: { AND: [
            scope, scopeCongressIntl(user),
            { status: { not: "CANCELLED" } }, { requestStatus: { notIn: [...ECARTEES] } },
            { startDate: { lt: to } }, { OR: [{ endDate: { gte: marge } }, { startDate: { gte: marge } }] },
          ] },
          select: { id: true, name: true, eventType: true, startDate: true, endDate: true, city: true, country: true, requesterId: true },
          orderBy: { startDate: "asc" }, take: PLAFOND,
        })
      : [],
    voitNat
      ? prisma.congressNational.findMany({
          where: { AND: [
            scope, scopeCongressNational(user),
            { status: { not: "CANCELLED" } }, { requestStatus: { notIn: [...ECARTEES] } },
            { date: { lt: to } }, { OR: [{ endDate: { gte: marge } }, { date: { gte: marge } }] },
          ] },
          select: { id: true, name: true, eventType: true, date: true, endDate: true, hostInstitution: true, city: true, country: true, requesterId: true },
          orderBy: { date: "asc" }, take: PLAFOND,
        })
      : [],
    voitEvt
      ? prisma.event.findMany({
          where: { AND: [
            scope,
            { status: { not: "CANCELLED" } },
            // `requestStatus` nul = événement organisé sans circuit de financement : il a lieu.
            { OR: [{ requestStatus: null }, { requestStatus: { notIn: [...ECARTEES] } }] },
            { startDate: { lt: to } }, { OR: [{ endDate: { gte: marge } }, { startDate: { gte: marge } }] },
          ] },
          select: { id: true, name: true, type: true, startDate: true, endDate: true, location: true, city: true, country: true, requesterId: true },
          orderBy: { startDate: "asc" }, take: PLAFOND,
        })
      : [],
  ]);

  const ids = [...new Set([...intl, ...nat, ...evts].map((r) => r.requesterId).filter((x): x is string => Boolean(x)))];
  const gens = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nom = (id: string | null) => (id ? gens.find((g) => g.id === id)?.name ?? null : null);

  const demandes: DemandeAdProDatee[] = [
    ...intl.map((r) => ({
      nature: "CONGRESS_INTERNATIONAL" as const, id: r.id, intitule: r.name,
      type: `${NATIONAL_EVENT_TYPE[r.eventType] ?? "Congrès"} · international`,
      debut: r.startDate!, fin: r.endDate, lieu: [r.city, r.country],
      demandeurId: r.requesterId, demandeur: nom(r.requesterId),
    })),
    ...nat.map((r) => ({
      nature: "CONGRESS_NATIONAL" as const, id: r.id, intitule: r.name,
      type: `${NATIONAL_EVENT_TYPE[r.eventType] ?? "Congrès"} · national`,
      debut: r.date!, fin: r.endDate, lieu: [r.hostInstitution, r.city, r.country],
      demandeurId: r.requesterId, demandeur: nom(r.requesterId),
    })),
    ...evts.map((r) => ({
      nature: "EVENT" as const, id: r.id, intitule: r.name,
      type: EVENT_TYPE[r.type] ?? "Événement",
      debut: r.startDate!, fin: r.endDate, lieu: [r.location, r.city, r.country],
      demandeurId: r.requesterId, demandeur: nom(r.requesterId),
    })),
  ];

  const debutYmd = algiersYmd(from);
  const finYmd = algiersYmd(new Date(to.getTime() - 1));
  return demandes.map(projeterDemandeAdPro).filter((e) => toucheLaFenetre(e, debutYmd, finYmd));
}
