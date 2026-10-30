/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CALENDRIER DU BANC PROGRAMMÉ (J5, décision 0022) — règle PURE : le passage est-il dû ?
 *
 * Le Super Admin règle une fréquence (chaque jour, chaque semaine, chaque mois), un jour et une heure, en
 * heure d'Alger (UTC+1, sans heure d'été). Le banc est DÛ quand le dernier créneau échu est postérieur au
 * dernier passage lancé. Un créneau manqué (worker arrêté, base d'essai absente) se rattrape UNE fois, au
 * battement suivant — jamais deux passages pour un même créneau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FREQUENCES = ["QUOTIDIEN", "HEBDOMADAIRE", "MENSUEL"] as const;
export type Frequence = (typeof FREQUENCES)[number];

export interface ReglageBanc {
  actif: boolean;
  frequence: Frequence;
  /** 0 = dimanche … 6 = samedi (HEBDOMADAIRE) ; 1 à 28 (MENSUEL) ; ignoré (QUOTIDIEN). */
  jour: number;
  heure: number;
  plafondUsd: number;
}

export const REGLAGE_BANC_DEFAUT: ReglageBanc = { actif: true, frequence: "HEBDOMADAIRE", jour: 5, heure: 3, plafondUsd: 1 };

export const PLAFOND_PASSAGE_MAX_USD = 20;
export const JOURS_SEMAINE = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;

const DECALAGE_ALGER_MS = 60 * 60 * 1000;
const borne = (n: unknown, min: number, max: number, defaut: number) => {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : defaut;
};

/** Une saisie quelconque RAMENÉE dans les bornes — l'écran relit ce qui a été réellement enregistré. */
export function normaliserReglageBanc(e: Partial<Record<keyof ReglageBanc, unknown>>): ReglageBanc {
  const frequence = (FREQUENCES as readonly string[]).includes(String(e.frequence)) ? (e.frequence as Frequence) : REGLAGE_BANC_DEFAUT.frequence;
  const plafond = Number(e.plafondUsd);
  return {
    actif: e.actif === undefined ? REGLAGE_BANC_DEFAUT.actif : e.actif === true || e.actif === "on" || e.actif === "true",
    frequence,
    jour: frequence === "MENSUEL" ? borne(e.jour, 1, 28, 1) : borne(e.jour, 0, 6, REGLAGE_BANC_DEFAUT.jour),
    heure: borne(e.heure, 0, 23, REGLAGE_BANC_DEFAUT.heure),
    plafondUsd: Number.isFinite(plafond) && plafond > 0 ? Math.min(PLAFOND_PASSAGE_MAX_USD, Math.round(plafond * 100) / 100) : REGLAGE_BANC_DEFAUT.plafondUsd,
  };
}

/** Le dernier créneau ÉCHU à `maintenant` (instant UTC). */
export function dernierCreneau(r: Pick<ReglageBanc, "frequence" | "jour" | "heure">, maintenant: Date): Date {
  const alger = new Date(maintenant.getTime() + DECALAGE_ALGER_MS);
  const c = new Date(Date.UTC(alger.getUTCFullYear(), alger.getUTCMonth(), alger.getUTCDate(), r.heure));
  if (r.frequence === "QUOTIDIEN") {
    if (c > alger) c.setUTCDate(c.getUTCDate() - 1);
  } else if (r.frequence === "HEBDOMADAIRE") {
    c.setUTCDate(c.getUTCDate() - ((c.getUTCDay() - r.jour + 7) % 7));
    if (c > alger) c.setUTCDate(c.getUTCDate() - 7);
  } else {
    c.setUTCDate(r.jour);
    if (c > alger) c.setUTCMonth(c.getUTCMonth() - 1, r.jour);
  }
  return new Date(c.getTime() - DECALAGE_ALGER_MS);
}

/** Le prochain créneau (pour l'écran : « prochain passage le … »). */
export function prochainCreneau(r: Pick<ReglageBanc, "frequence" | "jour" | "heure">, maintenant: Date): Date {
  const d = dernierCreneau(r, maintenant);
  const n = new Date(d);
  if (r.frequence === "QUOTIDIEN") n.setUTCDate(n.getUTCDate() + 1);
  else if (r.frequence === "HEBDOMADAIRE") n.setUTCDate(n.getUTCDate() + 7);
  else return dernierCreneau(r, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 28, 23)));
  return n;
}

/** Le passage programmé est-il dû ? `dernierLance` : le dernier passage PROGRAMMÉ (demandé), quel qu'en soit l'issue. */
export function passageDu(r: ReglageBanc, dernierLance: Date | null, maintenant: Date): boolean {
  if (!r.actif) return false;
  const c = dernierCreneau(r, maintenant);
  return !dernierLance || dernierLance < c;
}

/** Le calendrier, dit en clair (« chaque vendredi à 3 h, heure d'Alger »). */
export function calendrierLisible(r: Pick<ReglageBanc, "frequence" | "jour" | "heure" | "actif">): string {
  if (!r.actif) return "désactivé";
  const h = `${r.heure} h, heure d'Alger`;
  if (r.frequence === "QUOTIDIEN") return `chaque jour à ${h}`;
  if (r.frequence === "HEBDOMADAIRE") return `chaque ${JOURS_SEMAINE[r.jour] ?? "vendredi"} à ${h}`;
  return `le ${r.jour} de chaque mois à ${h}`;
}
