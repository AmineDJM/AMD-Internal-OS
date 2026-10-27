/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉVÉNEMENTS AD & PRO SONT EXTERNES (Direction, 27/10) — module PUR (zéro import).
 *
 * « Ce sont des événements pharma / scientifiques EXTERNES — staffs, webinaires, congrès d'autres
 * organisateurs : nous ne les organisons pas. » Ce qui servait à ORGANISER un événement n'a donc plus
 * d'objet : la capacité, la liste d'attente, les inscriptions publiques, et les états d'organisation
 * (« En préparation », « Inscriptions ouvertes », « Complet »).
 *
 * RIEN N'EST SUPPRIMÉ EN BASE : ni la colonne `capacity`, ni une valeur de l'énumération. Les événements
 * qui portent déjà ces états les gardent (et s'affichent) ; on cesse seulement de les ÉCRIRE et de les
 * PROPOSER. L'écran, l'action et Adam lisent les mêmes listes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les TYPES d'un événement externe, dans l'ordre du formulaire de création. */
export const TYPES_EVENEMENT_EXTERNE = [
  ["HOSPITAL_STAFF", "Staff"],
  ["WEBINAR", "Webinaire"],
  ["CONGRESS", "Congrès"],
  ["SCIENTIFIC_DAY", "Journée"],
  ["OTHER", "Autre"],
] as const;

export type TypeEvenementExterne = (typeof TYPES_EVENEMENT_EXTERNE)[number][0];

export function estTypeExterne(v: string | null | undefined): v is TypeEvenementExterne {
  return TYPES_EVENEMENT_EXTERNE.some(([k]) => k === v);
}

/** Les états d'ORGANISATION — ceux d'un événement que nous tiendrions nous-mêmes. Plus jamais écrits. */
export const STATUTS_ORGANISATION_RETIRES = ["PREPARATION", "REGISTRATION_OPEN", "FULL"] as const;

export function estStatutOrganisation(v: string | null | undefined): boolean {
  return (STATUTS_ORGANISATION_RETIRES as readonly string[]).includes(v ?? "");
}

/** La LISTE D'ATTENTE d'une inscription — elle suppose une capacité, que nous ne gérons plus. */
export const STATUTS_INSCRIPTION_RETIRES = ["PENDING"] as const;

export function estStatutInscriptionRetire(v: string | null | undefined): boolean {
  return (STATUTS_INSCRIPTION_RETIRES as readonly string[]).includes(v ?? "");
}

export const REFUS_ORGANISATION =
  "Les événements Ad & Pro sont externes : nous ne les organisons pas. « En préparation », « Inscriptions ouvertes » "
  + "et « Complet » ne se posent plus — l'état suit le circuit (brouillon, terminé, annulé).";

export const REFUS_INSCRIPTION_PUBLIQUE =
  "Les événements Ad & Pro sont externes : leurs inscriptions se font chez l'organisateur, pas ici.";

export const REFUS_LISTE_ATTENTE =
  "Les événements Ad & Pro sont externes : il n'y a ni capacité ni liste d'attente à tenir.";
