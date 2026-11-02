/**
 * Helpers de fuseau pour le calendrier — **sans dépendance serveur** (utilisables
 * côté client). Fuseau d'Alger (Africa/Algiers, UTC+1, sans heure d'été depuis
 * 1981). Les instants sont stockés en UTC ; on les interprète/affiche à Alger.
 */
import type { CalendarEventKind } from "@prisma/client";

export const ALGIERS_TZ = "Africa/Algiers";
const ALGIERS_OFFSET_MIN = 60;

export const CALENDAR_KINDS: CalendarEventKind[] = ["APPOINTMENT", "MEETING", "REMINDER", "DEADLINE", "INFO", "OTHER"];

/** « YYYY-MM-DD » du jour d'Alger correspondant à un instant (pour grouper par jour). */
export function algiersYmd(date: Date): string {
  const shifted = new Date(date.getTime() + ALGIERS_OFFSET_MIN * 60000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/** Heure locale d'Alger « HH:mm » d'un instant. */
export function algiersTime(date: Date): string {
  const shifted = new Date(date.getTime() + ALGIERS_OFFSET_MIN * 60000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/** Convertit une saisie « datetime-local » (heure d'Alger) en instant UTC. */
export function algiersInputToUtc(local: string): Date | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - ALGIERS_OFFSET_MIN * 60000);
}

/** Convertit un instant UTC en valeur « datetime-local » (heure d'Alger) pour un champ. */
export function utcToAlgiersInput(date: Date): string {
  const shifted = new Date(date.getTime() + ALGIERS_OFFSET_MIN * 60000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}T${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/** Affichage d'un instant au fuseau d'Alger (via Intl, toujours exact). */
export function formatAlgiers(date: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: ALGIERS_TZ, ...opts }).format(date);
}

/** Libellé compact pour l'agenda (« lun. 1 juil. à 14:30 » ou « 1 juil. (journée) »). */
export function formatAlgiersDisplay(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  if (allDay) return `${formatAlgiers(d, { weekday: "short", day: "2-digit", month: "short" })} (journée)`;
  return formatAlgiers(d, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Début → fin d'un événement : « lun. 20 oct. → mer. 22 oct. » pour des journées entières. */
export function formatPlageAlgiers(startIso: string, endIso: string | null, allDay: boolean): string {
  if (!endIso) return formatAlgiersDisplay(startIso, allDay);
  if (allDay) {
    const jour = (iso: string) => formatAlgiers(new Date(iso), { weekday: "short", day: "2-digit", month: "short" });
    return algiersYmd(new Date(startIso)) === algiersYmd(new Date(endIso))
      ? formatAlgiersDisplay(startIso, true)
      : `${jour(startIso)} → ${jour(endIso)}`;
  }
  return `${formatAlgiersDisplay(startIso, false)} → ${formatAlgiersDisplay(endIso, false)}`;
}

export const algiersTodayYmd = (): string => algiersYmd(new Date());

/**
 * Les jours civils de `debut` à `fin` inclus (« YYYY-MM-DD ») — un congrès de trois jours occupe
 * trois cases de la grille. Plafonné : une date de fin saisie avec une année de trop ne doit pas
 * fabriquer des centaines de cases.
 */
export function joursCouverts(debut: string, fin: string | null | undefined, max = 62): string[] {
  const a = Date.parse(`${debut}T00:00:00Z`);
  const b = fin ? Date.parse(`${fin}T00:00:00Z`) : a;
  if (Number.isNaN(a)) return [];
  const jours: string[] = [];
  for (let t = a; t <= (Number.isNaN(b) ? a : b) && jours.length < max; t += 86400000) {
    jours.push(new Date(t).toISOString().slice(0, 10));
  }
  return jours.length ? jours : [debut];
}

export interface GridDay { ymd: string; day: number; inMonth: boolean; isToday: boolean }

/** Grille d'un mois (semaines lundi→dimanche) en dates civiles. */
export function monthGrid(year: number, month: number): GridDay[] {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Lundi = 0
  const start = new Date(Date.UTC(year, month, 1 - lead));
  const today = algiersTodayYmd();
  const days: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    days.push({ ymd, day: d.getUTCDate(), inMonth: d.getUTCMonth() === month, isToday: ymd === today });
  }
  return days;
}

/** Jours CIVILS d'Alger écoulés entre deux instants — 0 le même jour, jamais négatif. */
export function joursCivilsDepuis(depuis: Date, maintenant: Date): number {
  const jour = (d: Date) => Date.parse(`${algiersYmd(d)}T00:00:00.000Z`) / 86_400_000;
  return Math.max(0, Math.round(jour(maintenant) - jour(depuis)));
}

/**
 * « depuis 3 j » — L'ANCIENNETÉ D'UNE ATTENTE, en jours civils d'Alger (lot E2 — audit 360°, 07-05).
 *
 * « depuis aujourd'hui », « depuis hier », puis « depuis N j ». En jours CIVILS et pas en tranches
 * de 24 h : une demande déposée hier à 23 h 30 attend « depuis hier » à 0 h 30, pas « depuis
 * aujourd'hui ». `null` sur une date absente ou illisible : on ne fabrique pas une ancienneté.
 * Sans dépendance serveur — la page et la file des congés (composant client) la lisent.
 */
export function depuisLisible(depuis: Date | string | null | undefined, maintenant: Date = new Date()): string | null {
  if (!depuis) return null;
  const d = typeof depuis === "string" ? new Date(depuis) : depuis;
  if (Number.isNaN(d.getTime())) return null;
  const n = joursCivilsDepuis(d, maintenant);
  return n === 0 ? "depuis aujourd'hui" : n === 1 ? "depuis hier" : `depuis ${n} j`;
}
