/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SALLES (lot T3, décision 0051 ; né « registre des moyens généraux ») — règles PURES, zéro import.
 *
 *   • la NATURE d'un moyen écrite en français (« la voiture », « l'assurance flotte », « contrat de ménage ») ;
 *   • le CHEVAUCHEMENT de deux créneaux (une salle, un véhicule ne se réservent pas deux fois).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TypeMoyen = "VEHICULE" | "ASSURANCE" | "CONTRAT_PRESTATAIRE" | "ENTRETIEN" | "FOURNITURE" | "SALLE" | "EQUIPEMENT" | "AUTRE";

export const LIBELLE_TYPE_MOYEN: Readonly<Record<TypeMoyen, string>> = {
  VEHICULE: "Véhicule", ASSURANCE: "Assurance", CONTRAT_PRESTATAIRE: "Contrat de prestataire", ENTRETIEN: "Entretien",
  FOURNITURE: "Fournitures", SALLE: "Salle", EQUIPEMENT: "Équipement", AUTRE: "Autre",
};

const replier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const MOTS: readonly [RegExp, TypeMoyen][] = [
  [/assuran|police|sinistre|assureur/, "ASSURANCE"],
  [/entretien|vidange|revision|controle technique|maintenance vehicule|pneu|garage/, "ENTRETIEN"],
  [/vehicule|voiture|camion|fourgon|utilitaire|auto|flotte|scooter|moto/, "VEHICULE"],
  [/salle|bureau de reunion|amphi|auditorium/, "SALLE"],
  [/contrat|prestataire|menage|nettoyage|gardiennage|securite|maintenance|abonnement|location|loyer|bail|internet|telephonie/, "CONTRAT_PRESTATAIRE"],
  [/fourniture|papeterie|consommable|toner|cartouche|ramette|papier/, "FOURNITURE"],
  [/equipement|ordinateur|imprimante|climatiseur|photocopieur|mobilier|materiel|serveur/, "EQUIPEMENT"],
];

/** La nature d'un moyen depuis un mot ou une phrase ; le code de l'énuméré passe tel quel ; `null` : illisible. */
export function lireTypeMoyen(brut: string | null | undefined): TypeMoyen | null {
  const s = String(brut ?? "").trim();
  if (!s) return null;
  const u = s.toUpperCase();
  if (u in LIBELLE_TYPE_MOYEN) return u as TypeMoyen;
  const r = replier(s);
  for (const [re, t] of MOTS) if (re.test(r)) return t;
  if (/autre/.test(r)) return "AUTRE";
  return null;
}

/** Les natures qui se RÉSERVENT (un créneau) — une assurance ne se réserve pas. */
export const TYPES_RESERVABLES: readonly TypeMoyen[] = ["SALLE"];
/**
 * Les natures qu'on ENREGISTRE encore (Direction, 02/11/2026 : « moyens généraux, c'est la caisse d'avance » — le registre
 * des véhicules, assurances et contrats ne correspond pas à Adventum). Les autres natures restent lisibles en base, inertes.
 */
export const TYPES_ENREGISTRABLES: readonly TypeMoyen[] = ["SALLE"];

/** Deux créneaux [début, fin[ se chevauchent-ils ? (bout à bout : non) */
export function chevauche(a: { debut: Date; fin: Date }, b: { debut: Date; fin: Date }): boolean {
  return a.debut.getTime() < b.fin.getTime() && b.debut.getTime() < a.fin.getTime();
}

/**
 * Un créneau lu : « 2026-11-12 », « 2026-11-12T10:00 », heures en Algérie (UTC+1, sans heure d'été).
 * Sans heure de fin : une heure. Sans heure du tout : la journée (8 h → 18 h). `null` : illisible ou fin ≤ début.
 */
export function lireCreneau(debut: string | null | undefined, fin?: string | null): { debut: Date; fin: Date } | null {
  const d = lireInstant(debut, "08:00");
  if (!d) return null;
  const sansHeure = !/T|\d{1,2}[:h]\d{0,2}/.test(String(debut ?? "").slice(10));
  const f = fin ? lireInstant(fin.length <= 5 && /^\d/.test(fin) ? `${String(debut).slice(0, 10)}T${fin}` : fin, "18:00")
    : new Date(d.getTime() + (sansHeure ? 10 : 1) * 3_600_000);
  if (!f || f.getTime() <= d.getTime()) return null;
  return { debut: d, fin: f };
}

function lireInstant(brut: string | null | undefined, heureParDefaut: string): Date | null {
  const s = String(brut ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2})[:h]?(\d{2})?)?/.exec(s);
  if (!m) return null;
  const [hh, mm] = m[4] !== undefined ? [Number(m[4]), Number(m[5] ?? 0)] : heureParDefaut.split(":").map(Number) as [number, number];
  if (hh > 23 || mm > 59) return null;
  // Algérie : UTC+1 toute l'année.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh - 1, mm));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** « 12/11/2026 10:00 » — heure d'Algérie. */
export function libelleInstant(d: Date): string {
  const a = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(a.getUTCDate())}/${p(a.getUTCMonth() + 1)}/${a.getUTCFullYear()} ${p(a.getUTCHours())}:${p(a.getUTCMinutes())}`;
}
