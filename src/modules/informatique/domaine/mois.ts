/**
 * LE MOIS D'IMPUTATION — « AAAA-MM », à l'heure d'Alger (UTC+1, sans heure d'été), comme les journaux de consommation IA
 * (`jourAlger`). Un appel passé le 31 à 23 h 30 à Alger appartient au mois qui finit, pas au suivant.
 *
 * Module PUR, sans import.
 */

const DECALAGE_ALGER_MS = 60 * 60 * 1000;
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Un mois lisible (« 2026-11 »), sinon `null` — jamais un mois deviné. */
export function lireMois(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const annee = Number(m[1]);
  const mois = Number(m[2]);
  if (annee < 2000 || annee > 2100 || mois < 1 || mois > 12) return null;
  return `${m[1]}-${m[2]}`;
}

const parties = (mois: string): [number, number] => [Number(mois.slice(0, 4)), Number(mois.slice(5, 7))];

/** Le mois (heure d'Alger) d'un instant. */
export function moisDe(instant: Date): string {
  const d = new Date(instant.getTime() + DECALAGE_ALGER_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Les bornes [début, fin[ du mois, en instants UTC : minuit d'Alger le 1er, minuit d'Alger le 1er du mois suivant. */
export function bornesDuMois(mois: string): { debut: Date; fin: Date } {
  const [a, m] = parties(mois);
  return {
    debut: new Date(Date.UTC(a, m - 1, 1) - DECALAGE_ALGER_MS),
    fin: new Date(Date.UTC(a, m, 1) - DECALAGE_ALGER_MS),
  };
}

export function moisPrecedent(mois: string): string {
  const [a, m] = parties(mois);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
}

/** « novembre 2026 ». */
export function libelleMois(mois: string): string {
  const [a, m] = parties(mois);
  return `${MOIS_FR[m - 1]} ${a}`;
}

export const anneeDuMois = (mois: string): number => parties(mois)[0];

/**
 * La DATE de la ligne de dépense budgétaire d'un mois : le dernier jour du mois, à midi UTC — toujours dans l'enveloppe
 * annuelle qui couvre le mois (1er janvier → 31 décembre 23 h 59), quel que soit le fuseau de l'écran qui la relit.
 */
export function dateDeLImputation(mois: string): Date {
  const [a, m] = parties(mois);
  return new Date(Date.UTC(a, m, 0, 12));
}

/** Les mois d'une année jusqu'au mois donné inclus (« 2026-01 » … « 2026-11 »). */
export function moisDeLAnneeJusqua(mois: string): string[] {
  const [a, m] = parties(mois);
  return Array.from({ length: m }, (_, i) => `${a}-${String(i + 1).padStart(2, "0")}`);
}
