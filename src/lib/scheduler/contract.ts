/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLANIFICATEUR PERSISTANT (§9) — le vocabulaire et le calcul des échéances. Zéro import.
 *
 * ── POURQUOI PAS UNE EXPRESSION CRON ─────────────────────────────────────────────────────
 *
 * `0 7 * * 0` est parfaitement expressif et parfaitement illisible pour la personne qui relit sa
 * planification trois mois plus tard. On lui préfère quatre récurrences nommées et deux champs
 * explicites (heure locale, jour). Ce qu'on perd en souplesse, on le gagne en ce que quelqu'un
 * puisse vérifier, seul, que « tous les dimanches à 7 h » veut bien dire ça.
 *
 * ── LE FUSEAU EST UNE RÈGLE MÉTIER, PAS UN DÉTAIL ────────────────────────────────────────
 *
 * L'entreprise est à Alger. « 7 h » veut dire 7 h à Alger, hiver comme été. Stocker une heure UTC
 * ferait dériver le rapport du lundi matin d'une heure deux fois par an — ce qui n'arriverait pas
 * ici (l'Algérie ne change pas d'heure), mais l'écrire explicitement évite qu'un futur lecteur
 * suppose l'inverse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Décalage fixe d'Alger : UTC+1 toute l'année. L'Algérie n'applique pas d'heure d'été. */
export const ALGIERS_OFFSET_HOURS = 1;

export type Recurrence = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export const RECURRENCES: readonly Recurrence[] = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"] as const;

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  HOURLY: "Toutes les heures",
  DAILY: "Tous les jours",
  WEEKLY: "Toutes les semaines",
  MONTHLY: "Tous les mois",
};

export type WorkflowStatus = "ACTIVE" | "PAUSED";
export type RunStatus = "OK" | "FAILED" | "SKIPPED";

const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

export interface Schedule {
  recurrence: Recurrence;
  /** Heure locale d'Alger (0-23). Ignorée pour `HOURLY`. */
  hourLocal: number;
  /** 0 = dimanche. Requis en pratique pour `WEEKLY` ; à défaut, lundi. */
  dayOfWeek?: number | null;
  /** 1-31 pour `MONTHLY` ; à défaut, le 1er. */
  dayOfMonth?: number | null;
}

/**
 * LA PROCHAINE ÉCHÉANCE, STRICTEMENT APRÈS `after`.
 *
 * « Strictement » n'est pas une subtilité : sans cela, une planification qui vient de tourner
 * calculerait une échéance égale à maintenant, serait immédiatement due, et tournerait en boucle
 * jusqu'à épuisement — la panne classique d'un planificateur maison.
 */
export function nextRunAt(s: Schedule, after: Date): Date {
  const hour = clamp(s.hourLocal, 0, 23);

  if (s.recurrence === "HOURLY") {
    // L'heure pleine suivante. L'heure locale ne joue aucun rôle : « toutes les heures » ne
    // s'ancre sur rien.
    const d = new Date(after);
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }

  // On raisonne en heure LOCALE en décalant l'instant, puis on revient en UTC à la fin. C'est
  // plus court et plus sûr que de corriger le fuseau à chaque branche.
  const local = new Date(after.getTime() + ALGIERS_OFFSET_HOURS * 3_600_000);
  const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0, 0, 0));

  if (s.recurrence === "DAILY") {
    if (candidate.getTime() <= local.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return toUtc(candidate);
  }

  if (s.recurrence === "WEEKLY") {
    const target = clamp(s.dayOfWeek ?? 1, 0, 6);
    let delta = (target - candidate.getUTCDay() + 7) % 7;
    // Le bon jour mais l'heure déjà passée : c'est la semaine PROCHAINE, pas dans une minute.
    if (delta === 0 && candidate.getTime() <= local.getTime()) delta = 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
    return toUtc(candidate);
  }

  // MONTHLY. Le jour demandé peut ne pas exister (le 31 en février) : on prend alors le DERNIER
  // jour du mois plutôt que de déborder sur le mois suivant, ce que ferait un simple `setDate(31)`
  // — et le « rapport du 31 » tomberait le 3 mars.
  const wanted = clamp(s.dayOfMonth ?? 1, 1, 31);
  let year = candidate.getUTCFullYear();
  let month = candidate.getUTCMonth();
  for (let i = 0; i < 2; i += 1) {
    const day = Math.min(wanted, daysInMonth(year, month));
    const c = new Date(Date.UTC(year, month, day, hour, 0, 0, 0));
    if (c.getTime() > local.getTime()) return toUtc(c);
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  // Inatteignable en pratique — deux mois suffisent toujours. Une valeur sûre plutôt qu'un throw.
  return toUtc(new Date(Date.UTC(year, month, 1, hour, 0, 0, 0)));
}

const toUtc = (local: Date): Date => new Date(local.getTime() - ALGIERS_OFFSET_HOURS * 3_600_000);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** La planification en une phrase — c'est ce que l'écran affiche, et ce qu'on peut vérifier. */
export function describeSchedule(s: Schedule): string {
  const h = `${String(clamp(s.hourLocal, 0, 23)).padStart(2, "0")} h`;
  switch (s.recurrence) {
    case "HOURLY": return "Toutes les heures";
    case "DAILY": return `Tous les jours à ${h}`;
    case "WEEKLY": return `Tous les ${DAY_NAMES[clamp(s.dayOfWeek ?? 1, 0, 6)]}s à ${h}`;
    case "MONTHLY": {
      const d = clamp(s.dayOfMonth ?? 1, 1, 31);
      return `Le ${d === 1 ? "1er" : d} de chaque mois à ${h}`;
    }
  }
}

/**
 * COMBIEN DE TEMPS ON GARDE L'HISTORIQUE D'UNE PLANIFICATION.
 *
 * Cinquante passages : assez pour voir une dérive ou une panne intermittente, assez peu pour
 * qu'une planification horaire ne remplisse pas la base avec deux ans de « OK ».
 */
export const RUN_HISTORY_KEEP = 50;

/**
 * AU-DELÀ, UN PASSAGE EST CONSIDÉRÉ PERDU et la planification redevient exécutable.
 *
 * Sans ce délai, un processus tué en plein traitement laisserait la planification « en cours »
 * pour toujours — elle ne tournerait plus jamais, sans qu'aucune erreur ne soit visible nulle
 * part. C'est la panne silencieuse la plus coûteuse d'un planificateur.
 */
export const STALE_CLAIM_MS = 15 * 60_000;
