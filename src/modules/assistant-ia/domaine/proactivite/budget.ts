import { RANG_GRAVITE, type CodeVeilleur, type Gravite } from "./veilleurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUDGET D'INTERRUPTIONS (J12, décision 0024) — un assistant qui prévient tout, tout le temps,
 * n'est plus lu au bout de trois jours.
 *
 * Trois règles, dans cet ordre :
 *   1. LES HEURES CALMES — le soir et la nuit (19 h → 8 h par défaut, heure d'Alger) et le week-end
 *      algérien (vendredi, samedi) : rien ne sonne. Les constats attendent ; ils partiront regroupés
 *      au prochain moment ouvert, ou dans le point du matin.
 *   2. LE REGROUPEMENT — un passage de la veille qui trouve trois constats ne dérange qu'UNE fois
 *      (« 3 points de vos veilleurs »). Et deux interruptions sont espacées d'au moins une heure : ce qui
 *      arrive entre-temps attend la suivante.
 *   3. LE PLAFOND — au plus N interruptions par personne et par jour (5 par défaut ; la personne
 *      peut baisser, la console fixe le plafond). Au-delà, les constats vont au JOURNAL : visibles à
 *      l'écran « Ce que mon assistant surveille », sans notification.
 *
 * Et une boucle : chaque constat se juge en un clic (« utile » / « pas utile »). Le taux d'utilité
 * est mesuré (cible : ≥ 60 %), et il AJUSTE le veilleur : pas utile → il attend plus longtemps avant
 * de parler (facteur sur son seuil) ; trop souvent pas utile → il devient DISCRET (journal seulement).
 *
 * PUR : l'heure, les compteurs et les préférences sont des paramètres.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const INTERRUPTIONS_PAR_DEFAUT = 5;
export const INTERRUPTIONS_MAX_CONSOLE = 20;
export const ECART_MIN_INTERRUPTIONS_MS = 60 * 60_000;
export const CIBLE_UTILE = 0.6;
/** Heure d'Alger = UTC+1, sans heure d'été. */
const DECALAGE_MS = 3_600_000;

export interface PreferencesVeille {
  interruptionsMax: number;
  /** Début et fin des heures calmes, heures entières d'Alger [debut, fin) — 19 → 8 traverse minuit. */
  calmeDebut: number;
  calmeFin: number;
  /** Vendredi et samedi calmes. */
  weekendCalme: boolean;
  pointDuMatin: boolean;
}

export const PREFERENCES_PAR_DEFAUT: PreferencesVeille = {
  interruptionsMax: INTERRUPTIONS_PAR_DEFAUT, calmeDebut: 19, calmeFin: 8, weekendCalme: true, pointDuMatin: true,
};

const entier = (v: unknown, min: number, max: number, defaut: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : defaut;
};

/** Un réglage lu (base, formulaire) ramené dans ses bornes ; la personne ne dépasse jamais le plafond de la console. */
export function normaliserPreferences(v: Partial<Record<keyof PreferencesVeille, unknown>>, plafondConsole = INTERRUPTIONS_PAR_DEFAUT): PreferencesVeille {
  const plafond = entier(plafondConsole, 0, INTERRUPTIONS_MAX_CONSOLE, INTERRUPTIONS_PAR_DEFAUT);
  return {
    interruptionsMax: Math.min(plafond, entier(v.interruptionsMax, 0, INTERRUPTIONS_MAX_CONSOLE, plafond)),
    calmeDebut: entier(v.calmeDebut, 0, 23, PREFERENCES_PAR_DEFAUT.calmeDebut),
    calmeFin: entier(v.calmeFin, 0, 23, PREFERENCES_PAR_DEFAUT.calmeFin),
    weekendCalme: typeof v.weekendCalme === "boolean" ? v.weekendCalme : PREFERENCES_PAR_DEFAUT.weekendCalme,
    pointDuMatin: typeof v.pointDuMatin === "boolean" ? v.pointDuMatin : PREFERENCES_PAR_DEFAUT.pointDuMatin,
  };
}

/** L'instant à Alger : heure (0–23), jour de la semaine (0 = dimanche), jour civil `AAAA-MM-JJ`. */
export function instantAlger(now: Date): { heure: number; jourSemaine: number; jour: string } {
  const l = new Date(now.getTime() + DECALAGE_MS);
  return { heure: l.getUTCHours(), jourSemaine: l.getUTCDay(), jour: l.toISOString().slice(0, 10) };
}

/** Minuit d'Alger du jour de `now`, en instant UTC — le début du compteur d'interruptions. */
export function debutDuJourAlger(now: Date): Date {
  return new Date(Date.parse(`${instantAlger(now).jour}T00:00:00.000Z`) - DECALAGE_MS);
}

export function estWeekend(now: Date): boolean {
  const j = instantAlger(now).jourSemaine;
  return j === 5 || j === 6;
}

/** Heures calmes ou week-end : rien ne sonne. */
export function estCalme(now: Date, p: Pick<PreferencesVeille, "calmeDebut" | "calmeFin" | "weekendCalme">): boolean {
  if (p.weekendCalme && estWeekend(now)) return true;
  const h = instantAlger(now).heure;
  if (p.calmeDebut === p.calmeFin) return false;
  return p.calmeDebut < p.calmeFin ? h >= p.calmeDebut && h < p.calmeFin : h >= p.calmeDebut || h < p.calmeFin;
}

/** Le moment du point du matin : premier passage d'un jour ouvré, dans les trois heures qui suivent la fin du calme. */
export function estMomentDuMatin(now: Date, p: PreferencesVeille, dernierMatin: Date | null): boolean {
  if (!p.pointDuMatin || estCalme(now, p)) return false;
  const { heure, jour } = instantAlger(now);
  if (heure < p.calmeFin || heure >= p.calmeFin + 3) return false;
  return !dernierMatin || instantAlger(dernierMatin).jour !== jour;
}

export interface Candidat {
  id: string;
  veilleur: CodeVeilleur;
  gravite: Gravite;
  /** Le veilleur est devenu discret (retours) : journal seulement. */
  discret: boolean;
}

export interface Repartition {
  /** Ceux qui partent ENSEMBLE, en une seule interruption (vide : personne n'est dérangé). */
  interruption: string[];
  /** Ceux qui attendent un moment ouvert (calme, ou interruption trop récente). */
  attente: string[];
  /** Ceux qui vont au journal sans notification (plafond du jour, veilleur discret). */
  journal: string[];
  raison: string;
}

/**
 * RÉPARTIR LES CONSTATS D'UN PASSAGE. `faites` = interruptions déjà parties aujourd'hui (heure
 * d'Alger) ; `derniere` = l'instant de la dernière.
 */
export function repartir(candidats: readonly Candidat[], p: PreferencesVeille, etat: { faites: number; derniere: Date | null }, now: Date): Repartition {
  const discrets = candidats.filter((c) => c.discret).map((c) => c.id);
  const ouverts = [...candidats.filter((c) => !c.discret)].sort((a, b) => RANG_GRAVITE[b.gravite] - RANG_GRAVITE[a.gravite]);
  if (!ouverts.length) return { interruption: [], attente: [], journal: discrets, raison: discrets.length ? "veilleur discret" : "rien" };
  if (estCalme(now, p)) return { interruption: [], attente: ouverts.map((c) => c.id), journal: discrets, raison: "heures calmes" };
  if (etat.faites >= p.interruptionsMax) {
    return { interruption: [], attente: [], journal: [...ouverts.map((c) => c.id), ...discrets], raison: `plafond du jour atteint (${p.interruptionsMax})` };
  }
  if (etat.derniere && now.getTime() - etat.derniere.getTime() < ECART_MIN_INTERRUPTIONS_MS) {
    return { interruption: [], attente: ouverts.map((c) => c.id), journal: discrets, raison: "regroupé avec la prochaine interruption" };
  }
  return { interruption: ouverts.map((c) => c.id), attente: [], journal: discrets, raison: ouverts.length > 1 ? `${ouverts.length} constats regroupés` : "une interruption" };
}

// ─────────────────────────────── Les retours « utile / pas utile » ───────────────────────────────

export interface Retours { utiles: number; inutiles: number }

/** Le taux d'utilité, ou `null` sans retour. */
export const tauxUtile = (r: Retours): number | null => (r.utiles + r.inutiles > 0 ? r.utiles / (r.utiles + r.inutiles) : null);

/** Discret : au moins 3 retours, et moins d'un sur trois jugé utile. */
export const estDiscret = (r: Retours): boolean => r.utiles + r.inutiles >= 3 && (tauxUtile(r) ?? 1) < 1 / 3;

export const FACTEUR_MAX = 3;

/** Le nouveau facteur de seuil après un retour : « pas utile » attend 25 % de plus, « utile » revient vers 1. */
export function ajusterFacteur(facteur: number, retour: "UTILE" | "PAS_UTILE"): number {
  const f = Number.isFinite(facteur) && facteur >= 1 ? facteur : 1;
  const n = retour === "PAS_UTILE" ? f * 1.25 : f / 1.1;
  return Math.round(Math.min(FACTEUR_MAX, Math.max(1, n)) * 100) / 100;
}

/** La phrase de mesure, la même à l'écran et à la console. */
export function phraseUtilite(r: Retours): string {
  const t = tauxUtile(r);
  if (t === null) return "Pas encore de retour.";
  const pct = Math.round(t * 100);
  return `${pct} % jugés utiles (${r.utiles} sur ${r.utiles + r.inutiles}) — cible ${Math.round(CIBLE_UTILE * 100)} %.`;
}
