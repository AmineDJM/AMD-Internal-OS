/**
 * LES REGISTRES DU DÉPARTEMENT INFORMATIQUE — abonnements & licences, parc informatique : listes fermées, libellés, lecture
 * des formulaires et calculs d'échéance. Saisie réelle par l'équipe : rien n'est préchargé.
 *
 * Module PUR, sans import : lu par les actions, les requêtes et les écrans clients.
 */

export const PERIODICITES = ["MENSUEL", "ANNUEL"] as const;
export type Periodicite = (typeof PERIODICITES)[number];
export const LIBELLE_PERIODICITE: Record<Periodicite, string> = { MENSUEL: "Mensuel", ANNUEL: "Annuel" };

export const DEVISES = ["DZD", "USD", "EUR"] as const;
export type Devise = (typeof DEVISES)[number];

export const STATUTS_ABONNEMENT = ["ACTIF", "RESILIE"] as const;
export type StatutAbonnement = (typeof STATUTS_ABONNEMENT)[number];
export const STATUT_ABONNEMENT: Record<StatutAbonnement, { label: string; tone: "success" | "neutral" }> = {
  ACTIF: { label: "Actif", tone: "success" },
  RESILIE: { label: "Résilié", tone: "neutral" },
};

export const TYPES_MATERIEL = ["PORTABLE", "FIXE", "ECRAN", "TELEPHONE", "TABLETTE", "IMPRIMANTE", "RESEAU", "SERVEUR", "AUTRE"] as const;
export type TypeMateriel = (typeof TYPES_MATERIEL)[number];
export const LIBELLE_TYPE_MATERIEL: Record<TypeMateriel, string> = {
  PORTABLE: "Ordinateur portable", FIXE: "Ordinateur fixe", ECRAN: "Écran", TELEPHONE: "Téléphone", TABLETTE: "Tablette",
  IMPRIMANTE: "Imprimante", RESEAU: "Réseau", SERVEUR: "Serveur", AUTRE: "Autre",
};

export const ETATS_MATERIEL = ["EN_SERVICE", "EN_STOCK", "EN_REPARATION", "HORS_SERVICE"] as const;
export type EtatMateriel = (typeof ETATS_MATERIEL)[number];
export const ETAT_MATERIEL: Record<EtatMateriel, { label: string; tone: "success" | "info" | "warning" | "neutral" }> = {
  EN_SERVICE: { label: "En service", tone: "success" },
  EN_STOCK: { label: "En stock", tone: "info" },
  EN_REPARATION: { label: "En réparation", tone: "warning" },
  HORS_SERVICE: { label: "Hors service", tone: "neutral" },
};

const dans = <T extends string>(liste: readonly T[], v: unknown): v is T => typeof v === "string" && (liste as readonly string[]).includes(v);
export const estPeriodicite = (v: unknown): v is Periodicite => dans(PERIODICITES, v);
export const estDevise = (v: unknown): v is Devise => dans(DEVISES, v);
export const estTypeMateriel = (v: unknown): v is TypeMateriel => dans(TYPES_MATERIEL, v);
export const estEtatMateriel = (v: unknown): v is EtatMateriel => dans(ETATS_MATERIEL, v);

/** Une date de formulaire (« AAAA-MM-JJ ») : `null` si vide, « illisible » sinon — jamais une date devinée. */
export function lireDate(s: string | null | undefined): Date | null | "illisible" {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return "illisible";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? "illisible" : d;
}

/** Un montant de formulaire : positif ou nul, au centime ; « illisible » sinon. */
export function lireMontant(s: string | null | undefined): number | null | "illisible" {
  if (s === null || s === undefined || s.trim() === "") return null;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return "illisible";
  return Math.round(n * 100) / 100;
}

/** Le coût annuel d'un abonnement, dans sa devise (un mensuel × 12). */
export function coutAnnuel(a: { periodicite: string; montant: number }): number {
  return Math.round((a.periodicite === "MENSUEL" ? a.montant * 12 : a.montant) * 100) / 100;
}

const JOUR_MS = 86_400_000;

/** Jours entiers jusqu'à l'échéance (négatif : dépassée). */
export function joursAvant(echeance: Date, maintenant: Date): number {
  return Math.floor((echeance.getTime() - maintenant.getTime()) / JOUR_MS);
}

/**
 * LE RAPPEL D'ÉCHÉANCE EST-IL DÛ ? — un abonnement actif, avec une échéance, entré dans sa fenêtre de rappel
 * (`rappelJours` avant), et pas encore rappelé POUR CETTE échéance : une échéance repoussée rouvre le rappel, la même
 * échéance ne sonne jamais deux fois. Une échéance passée depuis plus de 30 jours ne rappelle plus (elle se lit à l'écran).
 */
export function rappelDu(a: { statut: string; echeance: Date | null; rappelJours: number; rappelEnvoyePour: Date | null }, maintenant: Date): boolean {
  if (a.statut !== "ACTIF" || !a.echeance) return false;
  if (a.rappelEnvoyePour && a.rappelEnvoyePour.getTime() === a.echeance.getTime()) return false;
  const j = joursAvant(a.echeance, maintenant);
  return j <= Math.max(0, a.rappelJours) && j >= -30;
}

/** La garantie d'un matériel : « sous garantie », « expire bientôt » (≤ 60 j), « expirée », ou rien. */
export function etatGarantie(finGarantie: Date | null, maintenant: Date): "SOUS_GARANTIE" | "BIENTOT" | "EXPIREE" | null {
  if (!finGarantie) return null;
  const j = joursAvant(finGarantie, maintenant);
  if (j < 0) return "EXPIREE";
  return j <= 60 ? "BIENTOT" : "SOUS_GARANTIE";
}
