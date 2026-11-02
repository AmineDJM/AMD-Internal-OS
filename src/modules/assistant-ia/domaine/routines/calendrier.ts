/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CALENDRIER D'UNE ROUTINE — quand elle passe, dit en français. Module pur, zéro import.
 *
 * Heure d'ALGER, toujours : UTC+1 toute l'année (l'Algérie n'applique pas d'heure d'été). Une
 * routine « dimanche à 8 h » passe à 8 h à Alger, hiver comme été, quel que soit l'endroit d'où
 * la personne l'a programmée — c'est la panne la plus citée des tâches planifiées de ChatGPT.
 *
 * La prochaine échéance est STRICTEMENT après l'instant donné : une routine qui vient de passer ne
 * redevient pas due dans la même minute.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DECALAGE_ALGER_H = 1;
export const FUSEAU = "heure d'Alger";

export type Frequence = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface Calendrier {
  frequence: Frequence;
  intervalle: number;
  /** WEEKLY : 0 = dimanche … 6 = samedi. */
  jours: number[];
  /** MONTHLY : 1-31, ou -1 = dernier jour du mois. */
  jourDuMois: number | null;
  heure: number;
  minute: number;
  /** ONCE : l'instant unique ; sinon l'ancre (rien avant). */
  debutLe: Date;
  finLe: Date | null;
  maxExecutions: number | null;
}

export const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOUR_MS = 86_400_000;

/** L'instant vu à Alger, porté par un Date dont les champs UTC sont l'heure locale. */
const local = (d: Date) => new Date(d.getTime() + DECALAGE_ALGER_H * 3_600_000);
const versUtc = (l: Date) => new Date(l.getTime() - DECALAGE_ALGER_H * 3_600_000);
const jourLocal = (d: Date) => Math.floor(local(d).getTime() / JOUR_MS);
const dernierJour = (annee: number, mois: number) => new Date(Date.UTC(annee, mois + 1, 0)).getUTCDate();

/** Le jour (numéro de jour depuis l'époque, à Alger) tombe-t-il dans la règle ? */
function jourRetenu(c: Calendrier, jour: number, ancre: number): boolean {
  const n = Math.max(1, Math.round(c.intervalle) || 1);
  const d = new Date(jour * JOUR_MS);
  if (c.frequence === "DAILY") return (jour - ancre) % n === 0;
  if (c.frequence === "WEEKLY") {
    if (!c.jours.includes(d.getUTCDay())) return false;
    // Semaines comptées du dimanche au samedi, depuis la semaine de l'ancre.
    const semaine = (j: number) => Math.floor((j - new Date(j * JOUR_MS).getUTCDay()) / 7);
    return (semaine(jour) - semaine(ancre)) % n === 0;
  }
  if (c.frequence === "MONTHLY") {
    const a = new Date(ancre * JOUR_MS);
    const mois = (d.getUTCFullYear() - a.getUTCFullYear()) * 12 + d.getUTCMonth() - a.getUTCMonth();
    if (mois % n !== 0) return false;
    const fin = dernierJour(d.getUTCFullYear(), d.getUTCMonth());
    // Le 31 d'un mois de 30 jours : le dernier jour du mois, pas le 1er du suivant.
    const voulu = c.jourDuMois === -1 ? fin : Math.min(c.jourDuMois ?? 1, fin);
    return d.getUTCDate() === voulu;
  }
  return false;
}

/** LA PROCHAINE ÉCHÉANCE strictement après `apres` — `null` : la routine est terminée. */
export function prochaineExecution(c: Calendrier, apres: Date, executionsFaites = 0): Date | null {
  if (c.maxExecutions != null && executionsFaites >= c.maxExecutions) return null;
  if (c.frequence === "ONCE") return executionsFaites === 0 && c.debutLe.getTime() > apres.getTime() ? c.debutLe : null;
  const ancre = jourLocal(c.debutLe);
  const depart = Math.max(jourLocal(apres), ancre);
  const horizon = 31 * 12 * Math.max(1, c.intervalle) + 31;
  for (let j = depart; j <= depart + horizon; j++) {
    if (!jourRetenu(c, j, ancre)) continue;
    const t = versUtc(new Date(j * JOUR_MS + (c.heure * 60 + c.minute) * 60_000));
    if (t.getTime() <= apres.getTime() || t.getTime() < c.debutLe.getTime()) continue;
    if (c.finLe && t.getTime() > c.finLe.getTime()) return null;
    return t;
  }
  return null;
}

export function prochaines(c: Calendrier, n: number, depuis: Date): Date[] {
  const out: Date[] = [];
  let t: Date | null = depuis;
  for (let i = 0; i < n && t; i++) {
    t = prochaineExecution(c, t, i);
    if (t) out.push(t);
  }
  return out;
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** « dimanche 2 novembre 2026 à 08:00 » — l'instant dit à Alger. */
export function dateLongue(d: Date): string {
  const l = local(d);
  return `${JOURS[l.getUTCDay()]} ${l.getUTCDate() === 1 ? "1er" : l.getUTCDate()} ${MOIS[l.getUTCMonth()]} ${l.getUTCFullYear()} à ${hhmm(l.getUTCHours(), l.getUTCMinutes())}`;
}

function listeJours(jours: number[]): string {
  const tri = [...new Set(jours)].sort((a, b) => a - b);
  const ouvres = [0, 1, 2, 3, 4];
  if (tri.length === 5 && ouvres.every((j) => tri.includes(j))) return "du dimanche au jeudi";
  if (tri.length === 7) return "tous les jours";
  const noms = tri.map((j) => JOURS[j]!);
  return noms.length === 1 ? `chaque ${noms[0]}` : `chaque ${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;
}

/** La routine en une phrase — ce que la carte et la liste affichent, vérifiable par la personne. */
export function decrireCalendrier(c: Calendrier): string {
  const h = `à ${hhmm(c.heure, c.minute)} (${FUSEAU})`;
  const n = Math.max(1, c.intervalle);
  let base: string;
  if (c.frequence === "ONCE") return `une seule fois, le ${dateLongue(c.debutLe)} (${FUSEAU})`;
  if (c.frequence === "DAILY") base = n === 1 ? `tous les jours ${h}` : `tous les ${n} jours ${h}`;
  else if (c.frequence === "WEEKLY") base = n === 1 ? `${listeJours(c.jours)} ${h}` : `toutes les ${n} semaines, ${listeJours(c.jours).replace(/^chaque /, "le ")} ${h}`;
  else {
    const j = c.jourDuMois === -1 ? "le dernier jour" : `le ${c.jourDuMois === 1 || c.jourDuMois == null ? "1er" : c.jourDuMois}`;
    base = n === 1 ? `${j} de chaque mois ${h}` : `${j} du mois, tous les ${n} mois, ${h}`;
  }
  const fins = [c.finLe ? `jusqu'au ${dateLongue(c.finLe).replace(/ à .*$/, "")}` : null, c.maxExecutions ? `${c.maxExecutions} fois au plus` : null].filter(Boolean);
  return fins.length ? `${base}, ${fins.join(", ")}` : base;
}
