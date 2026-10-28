/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES DE CONSOMMATION DE L'ASSISTANT IA — PURES (aucun import) : l'écran du Super Admin
 * (composant client) et le moteur (`consommation.ts`, serveur) lisent les MÊMES défauts, bornes et
 * phrases. Lot V3-D, audit 27/10 rapport 06 (IA-ASSISTANT-03).
 *
 * ── POURQUOI DES JETONS, ET PAS DES DOLLARS ──────────────────────────────────────────────
 *
 * Le plafond se compte en JETONS (entrée + sortie), pas en coût : le tarif de MiMo n'est pas inscrit
 * dans le code (il se pose dans l'environnement, `ASSISTANT_IA_PRICE_IN` / `ASSISTANT_IA_PRICE_OUT`), et un plafond
 * qui ne tiendrait plus le jour où le tarif manque ne serait pas un plafond. Le coût, lui, est
 * ESTIMÉ et affiché quand le tarif est connu — « inconnu » sinon, jamais zéro.
 *
 * ── LES DÉFAUTS, MESURÉS ─────────────────────────────────────────────────────────────────
 *
 * Mesure du rapport 06 : ≈ 9 000 jetons d'entrée FIXES renvoyés à chaque étape (38 outils, prompt
 * système). Une question ordinaire (2 à 3 étapes) coûte donc 20 à 30 k jetons ; le pire tour d'avant
 * (arrière-plan, 24 étapes) ≥ 216 k.
 *   • 12 étapes au plus par tour (la conversation en demande 8 ; l'arrière-plan en avait 24).
 *   • 150 000 jetons par tour : 12 étapes pleines, ou un long résumé de document.
 *   • 600 000 jetons par personne et par jour : une vingtaine de questions, ou quatre gros travaux.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ReglagesAssistantIa {
  plafondJetonsJour: number;
  plafondJetonsTour: number;
  etapesMaxTour: number;
  /** Décision IA-ASSISTANT-09 (option prudente) : le message saisi et l'historique sont filtrés. */
  censurerSaisie: boolean;
  /** Décision IA-ASSISTANT-10 (option prudente) : une carte dont on reparle est retirée avant le tour. */
  retirerCartesCaduques: boolean;
  /** IA-ASSISTANT-07 : une carte jamais confirmée expire après ce délai. */
  expirationCartesHeures: number;
}

export const REGLAGES_PAR_DEFAUT: ReglagesAssistantIa = {
  plafondJetonsJour: 600_000,
  plafondJetonsTour: 150_000,
  etapesMaxTour: 12,
  censurerSaisie: true,
  retirerCartesCaduques: true,
  expirationCartesHeures: 24,
};

/** Les bornes de l'écran : un réglage hors bornes est ramené dedans, jamais refusé en silence. */
export const BORNES = {
  plafondJetonsJour: { min: 10_000, max: 50_000_000 },
  plafondJetonsTour: { min: 5_000, max: 2_000_000 },
  etapesMaxTour: { min: 1, max: 24 },
  expirationCartesHeures: { min: 1, max: 24 * 30 },
} as const;

type CleNombre = keyof typeof BORNES;

export function borner(cle: CleNombre, v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return REGLAGES_PAR_DEFAUT[cle];
  return Math.min(BORNES[cle].max, Math.max(BORNES[cle].min, n));
}

/** Une ligne lue (ou saisie) ramenée à des réglages valides — les booléens absents gardent le défaut. */
export function normaliserReglages(r: Partial<Record<keyof ReglagesAssistantIa, unknown>> | null | undefined): ReglagesAssistantIa {
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    plafondJetonsJour: r?.plafondJetonsJour == null ? REGLAGES_PAR_DEFAUT.plafondJetonsJour : borner("plafondJetonsJour", r.plafondJetonsJour),
    plafondJetonsTour: r?.plafondJetonsTour == null ? REGLAGES_PAR_DEFAUT.plafondJetonsTour : borner("plafondJetonsTour", r.plafondJetonsTour),
    etapesMaxTour: r?.etapesMaxTour == null ? REGLAGES_PAR_DEFAUT.etapesMaxTour : borner("etapesMaxTour", r.etapesMaxTour),
    expirationCartesHeures: r?.expirationCartesHeures == null ? REGLAGES_PAR_DEFAUT.expirationCartesHeures : borner("expirationCartesHeures", r.expirationCartesHeures),
    censurerSaisie: b(r?.censurerSaisie, REGLAGES_PAR_DEFAUT.censurerSaisie),
    retirerCartesCaduques: b(r?.retirerCartesCaduques, REGLAGES_PAR_DEFAUT.retirerCartesCaduques),
  };
}

/**
 * LE JOUR, HEURE D'ALGER — l'Algérie est à UTC+1 toute l'année (pas d'heure d'été) : minuit à Alger
 * est 23 h UTC la veille. Un plafond « par jour » qui basculerait à 1 h du matin surprendrait.
 */
const DECALAGE_ALGER_MS = 60 * 60 * 1000;

export function debutJourAlger(now: Date = new Date()): Date {
  const local = new Date(now.getTime() + DECALAGE_ALGER_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - DECALAGE_ALGER_MS);
}

/** La date (sans heure) du jour d'Alger — la clé de `AssistantIaPlafondAtteint`. */
export function jourAlger(now: Date = new Date()): Date {
  const local = new Date(now.getTime() + DECALAGE_ALGER_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** Le tarif d'un modèle, en dollars par MILLION de jetons. */
export interface Tarif { entreeParM: number; sortieParM: number }

/** Coût ESTIMÉ d'un appel : `null` quand le tarif est inconnu — un coût inconnu n'est jamais zéro. */
export function coutEstimeUsd(entree: number, sortie: number, tarif: Tarif | null): number | null {
  if (!tarif) return null;
  return Math.round(((entree * tarif.entreeParM + sortie * tarif.sortieParM) / 1_000_000) * 1_000_000) / 1_000_000;
}

const fmt = (n: number) => n.toLocaleString("fr-FR").replace(/ | /g, " ");

/** OÙ SE RÈGLE LE PLAFOND — nommé dans chaque refus (§118.30 : un refus nomme son remède). */
export const ECRAN_CONSOMMATION = "Administration › Contrôle de l'IA › Consommation IA";

export function refusPlafondJour(plafond: number): string {
  return `Vous avez atteint votre plafond quotidien d'Assistant IA (${fmt(plafond)} jetons) : aucun appel n'est parti. `
    + `Il se réinitialise à minuit (heure d'Alger) ; le Super Admin peut le relever dans ${ECRAN_CONSOMMATION}.`;
}

export function refusPlafondTour(plafond: number, parJour: boolean): string {
  return parJour
    ? `L'assistant s'est arrêté avant de finir : cette demande aurait dépassé votre plafond quotidien (${fmt(plafond)} jetons restants). `
      + `Il se réinitialise à minuit (heure d'Alger) ; le Super Admin peut le relever dans ${ECRAN_CONSOMMATION}.`
    : `L'assistant s'est arrêté avant de finir : cette demande a atteint le plafond d'un tour (${fmt(plafond)} jetons). `
      + `Découpez-la en demandes plus courtes ; le Super Admin peut relever ce plafond dans ${ECRAN_CONSOMMATION}.`;
}
