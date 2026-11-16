/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORDRE DE « MES DEMANDES » DE PAIEMENT — choisi par la personne (Direction, 10/11/2026 : « affichées de la plus
 * récente à la plus ancienne, et l'utilisateur peut les ordonner comme il veut, selon SA priorité »).
 *
 * Par défaut, la plus récente en tête (la date où la demande a été créée). Un menu « Trier par » propose les autres
 * ordres, et « Ma priorité » range selon l'ordre que la personne a choisi (↑ / ↓, gardé en base : `rangDemandeur`).
 * Cet ordre n'est QUE le sien : la file des Finances garde son tri par échéance (`sortByPriority`).
 *
 * Module PUR (navigateur compris) : les trois listes — /validations, /validations/paiements, et « Vos demandes en
 * cours » du formulaire — trient avec la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TRIS_MES_DEMANDES = ["RECENTES", "ANCIENNES", "ECHEANCE", "MONTANT", "STATUT", "MA_PRIORITE"] as const;
export type TriMesDemandes = (typeof TRIS_MES_DEMANDES)[number];
export const TRI_PAR_DEFAUT: TriMesDemandes = "RECENTES";

export const LIBELLE_TRI: Record<TriMesDemandes, string> = {
  RECENTES: "Plus récentes",
  ANCIENNES: "Plus anciennes",
  ECHEANCE: "Échéance la plus proche",
  MONTANT: "Montant",
  STATUT: "Statut",
  MA_PRIORITE: "Ma priorité",
};

export const estTriMesDemandes = (v: unknown): v is TriMesDemandes =>
  typeof v === "string" && (TRIS_MES_DEMANDES as readonly string[]).includes(v);

/** Ce que le tri lit d'une demande. */
export interface CleDeTri {
  id: string;
  /** ISO — la date où la demande a été créée. */
  creeLe: string;
  montant: number;
  statut: string;
  /** Sa place dans le tri par échéance (`sortByPriority`, calculé côté serveur). */
  rangEcheance: number;
  /** Sa place choisie par la personne — `null` tant qu'elle ne l'a pas rangée. */
  rang: number | null;
}

/**
 * LE STATUT, de ce qui attend la personne à ce qui est clos : à revoir, brouillon, en attente, envoyée, en examen,
 * acceptée, refusée, annulée.
 */
const ORDRE_STATUT: Record<string, number> = {
  CHANGES_REQUESTED: 0, DRAFT: 1, ON_HOLD: 2, SUBMITTED: 3, UNDER_REVIEW: 4, APPROVED: 5, REJECTED: 6, CANCELLED: 7,
};

const date = (iso: string) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};
const plusRecente = (a: CleDeTri, b: CleDeTri) => date(b.creeLe) - date(a.creeLe) || a.id.localeCompare(b.id);

/**
 * Les demandes dans l'ordre demandé. « Ma priorité » : celles que la personne a rangées, dans son ordre ; celles qu'elle
 * n'a pas encore rangées (une demande NEUVE) passent EN TÊTE, la plus récente d'abord. Pur, ne modifie pas l'entrée.
 */
export function trierMesDemandes<T extends CleDeTri>(demandes: readonly T[], tri: TriMesDemandes): T[] {
  const l = [...demandes];
  switch (tri) {
    case "ANCIENNES":
      return l.sort((a, b) => -plusRecente(a, b));
    case "ECHEANCE":
      return l.sort((a, b) => a.rangEcheance - b.rangEcheance || plusRecente(a, b));
    case "MONTANT":
      return l.sort((a, b) => b.montant - a.montant || plusRecente(a, b));
    case "STATUT":
      return l.sort((a, b) => (ORDRE_STATUT[a.statut] ?? 99) - (ORDRE_STATUT[b.statut] ?? 99) || plusRecente(a, b));
    case "MA_PRIORITE":
      return l.sort((a, b) => {
        if (a.rang === null && b.rang === null) return plusRecente(a, b);
        if (a.rang === null) return -1;
        if (b.rang === null) return 1;
        return a.rang - b.rang || plusRecente(a, b);
      });
    case "RECENTES":
    default:
      return l.sort(plusRecente);
  }
}

/**
 * Monter (−1) ou descendre (+1) une demande dans SON ordre : l'ordre complet qui en résulte, à enregistrer tel quel
 * (chaque demande y prend son rang). `null` quand le geste ne déplace rien (déjà en tête, déjà en bas, inconnue).
 */
export function deplacerDansMonOrdre<T extends CleDeTri>(demandes: readonly T[], id: string, sens: -1 | 1): string[] | null {
  const ordre = trierMesDemandes(demandes, "MA_PRIORITE").map((d) => d.id);
  const i = ordre.indexOf(id);
  const j = i + sens;
  if (i < 0 || j < 0 || j >= ordre.length) return null;
  [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
  return ordre;
}

/**
 * METTRE EN TÊTE une demande choisie (Direction, 16/11/2026 : « choisir celles qui passent d'abord ») : l'ordre complet
 * qui en résulte, les autres gardant leur place relative. `null` quand elle y est déjà, ou est inconnue.
 */
export function mettreEnTeteDeMonOrdre<T extends CleDeTri>(demandes: readonly T[], id: string): string[] | null {
  const ordre = trierMesDemandes(demandes, "MA_PRIORITE").map((d) => d.id);
  const i = ordre.indexOf(id);
  if (i <= 0) return null;
  return [id, ...ordre.slice(0, i), ...ordre.slice(i + 1)];
}

/**
 * LA DATE DE LA DEMANDE, telle que la liste l'affiche (« Demandée le », Direction 16/11/2026) : jour et heure, à l'heure
 * d'Alger — fixée pour que le serveur et le navigateur écrivent la même chose (sinon l'hydratation diverge vers minuit).
 */
export function dateDeLaDemande(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers",
  }).format(d);
}

/** Le plus grand nombre de demandes qu'un seul enregistrement d'ordre peut ranger. */
export const ORDRE_MAX = 500;
