/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VALIDITÉ D'UNE DÉCISION D'ENREGISTREMENT — les règles, PURES (Super Admin, 24/11/2026).
 *
 * « La décision d'enregistrement dure 5 ans : la fin de validité, c'est 5 ans. L'IA doit deviner la
 * fin de validité parce que c'est normalement 5 ans. Il faut une alerte sur le renouvellement. »
 *
 * Ce module dit, sans rien lire : la fin DÉDUITE (début + 5 ans), le statut du jour (valide / à
 * renouveler / expirée), le palier d'alerte atteint (12, 6, 1 mois, puis expirée) et s'il faut
 * prévenir, et la SOURCE d'une date confirmée (lue par l'IA, déduite, saisie). Zéro import : la
 * fiche, le balayage, « Aujourd'hui », les composants client et les tests le partagent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La durée légale d'une décision d'enregistrement ANPP. */
export const VALIDITE_ENREGISTREMENT_ANS = 5;

/**
 * LES PALIERS D'ALERTE, en mois avant la fin — le premier ouvre « à renouveler ». Réglable ici : le
 * dossier de renouvellement se dépose 180 jours avant l'expiration (ANPP), un an laisse le temps de
 * réunir le Module 1 ; un mois est le dernier rappel utile.
 */
export const PALIERS_ALERTE_MOIS = [12, 6, 1] as const;
/** Le palier « expirée » — après le dernier, il sonne une fois, au rouge. */
export const PALIER_EXPIREE = 0;

export const SOURCES_DATE = ["LUE_IA", "DEDUITE", "SAISIE"] as const;
export type SourceDate = (typeof SOURCES_DATE)[number];

export const LIBELLE_SOURCE_DATE: Record<SourceDate, string> = {
  LUE_IA: "lue par l'IA",
  DEDUITE: `déduite (+${VALIDITE_ENREGISTREMENT_ANS} ans)`,
  SAISIE: "saisie",
};

export function estSourceDate(v: unknown): v is SourceDate {
  return typeof v === "string" && (SOURCES_DATE as readonly string[]).includes(v);
}

export type StatutValidite = "VALIDE" | "A_RENOUVELER" | "EXPIREE";

export const STATUT_VALIDITE: Record<StatutValidite, { label: string; tone: "success" | "warning" | "danger" }> = {
  VALIDE: { label: "Valide", tone: "success" },
  A_RENOUVELER: { label: "À renouveler", tone: "warning" },
  EXPIREE: { label: "Expirée", tone: "danger" },
};

// ─────────────────────────── Les dates (jours civils, en UTC) ───────────────────────────

/** Une date « AAAA-MM-JJ » ou un instant → minuit UTC de ce jour ; `null` si illisible. */
export function jourUtc(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** « AAAA-MM-JJ » d'un jour. */
export const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Ajoute des mois, en restant DANS le mois visé : le 31 mars moins un mois est le 28 (ou 29) février,
 * pas le 3 mars — un rappel ne saute pas un mois parce que le précédent est plus court.
 */
export function ajouterMois(d: Date, mois: number): Date {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + mois;
  const annee = Math.floor(total / 12);
  const m = total - annee * 12;
  const dernier = new Date(Date.UTC(annee, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(annee, m, Math.min(d.getUTCDate(), dernier)));
}

/** LA FIN DÉDUITE : début + 5 ans (un 29 février tombe le 28). */
export function finDeduite(debut: Date): Date {
  return ajouterMois(jourUtc(debut)!, VALIDITE_ENREGISTREMENT_ANS * 12);
}

// ─────────────────────────── Le statut, les paliers ───────────────────────────

/**
 * LE PALIER ATTEINT ce jour : 0 si la décision est expirée (le jour de fin est encore valide), sinon le
 * plus petit palier dont l'entrée est passée (12, 6 ou 1), `null` avant le premier.
 */
export function palierAtteint(fin: Date | string | null | undefined, maintenant: Date): number | null {
  const f = jourUtc(fin);
  const j = jourUtc(maintenant);
  if (!f || !j) return null;
  if (j.getTime() > f.getTime()) return PALIER_EXPIREE;
  let atteint: number | null = null;
  for (const m of PALIERS_ALERTE_MOIS) if (j.getTime() >= ajouterMois(f, -m).getTime()) atteint = atteint === null ? m : Math.min(atteint, m);
  return atteint;
}

/** Le statut du jour ; `null` sans fin de validité connue. */
export function statutValidite(fin: Date | string | null | undefined, maintenant: Date): StatutValidite | null {
  const p = palierAtteint(fin, maintenant);
  if (!jourUtc(fin)) return null;
  if (p === PALIER_EXPIREE) return "EXPIREE";
  return p === null ? "VALIDE" : "A_RENOUVELER";
}

/**
 * FAUT-IL PRÉVENIR, ET POUR QUEL PALIER ? Une fois par palier et par fin de validité : la fin a changé
 * (une nouvelle décision) → les paliers se rouvrent ; sinon seul un palier PLUS PROCHE de la fin que le
 * dernier envoyé sonne. Un dossier découvert à trois mois de la fin sonne « 6 mois » une fois, pas 12 puis 6.
 */
export function palierAPrevenir(e: {
  fin: Date | string | null | undefined;
  maintenant: Date;
  dernierPalier: number | null;
  finPrevenue: Date | string | null | undefined;
}): number | null {
  const p = palierAtteint(e.fin, e.maintenant);
  if (p === null) return null;
  const memeFin = jourUtc(e.finPrevenue)?.getTime() === jourUtc(e.fin)?.getTime();
  if (!memeFin || e.dernierPalier === null) return p;
  return p < e.dernierPalier ? p : null;
}

/** Le libellé d'un palier, pour une alerte. */
export function libellePalier(palier: number): string {
  if (palier === PALIER_EXPIREE) return "expirée";
  return palier === 1 ? "à 1 mois de la fin" : `à ${palier} mois de la fin`;
}

// ─────────────────────────── La confirmation : la source de chaque date ───────────────────────────

/**
 * LA SOURCE D'UNE VALEUR CONFIRMÉE : celle de la proposition quand la personne l'a gardée telle quelle,
 * « saisie » dès qu'elle l'a changée — une date corrigée à la main n'est plus une lecture de l'IA.
 */
export function sourceRetenue(saisie: string | null, proposition: { valeur: string; source: SourceDate } | null | undefined): SourceDate | null {
  if (!saisie) return null;
  if (proposition && proposition.valeur === saisie) return proposition.source;
  return "SAISIE";
}

export interface DatesSaisies {
  numero: string | null;
  dateDecision: string | null;
  debut: string | null;
  fin: string | null;
}

export interface PropositionsDeDates {
  numero?: { valeur: string; source: SourceDate } | null;
  dateDecision?: { valeur: string; source: SourceDate } | null;
  debut?: { valeur: string; source: SourceDate } | null;
  fin?: { valeur: string; source: SourceDate } | null;
}

export type ValiditeRetenue =
  | {
      ok: true;
      numero: string | null;
      dateDecision: Date | null; sourceDecision: SourceDate | null;
      debut: Date | null; sourceDebut: SourceDate | null;
      fin: Date | null; sourceFin: SourceDate | null;
    }
  | { ok: false; error: string };

/**
 * CE QUI SERA ÉCRIT, à partir de la saisie et des propositions de l'IA. Le début manquant reprend la date
 * de la décision (la DE vaut à sa signature) ; la fin manquante est DÉDUITE (début + 5 ans). Une fin
 * avant le début est refusée — avec le remède.
 */
export function validiteRetenue(s: DatesSaisies, p: PropositionsDeDates = {}): ValiditeRetenue {
  const lire = (v: string | null): Date | null | "illisible" => (v ? jourUtc(v) ?? "illisible" : null);
  const dateDecision = lire(s.dateDecision);
  const debutSaisi = lire(s.debut);
  const finSaisie = lire(s.fin);
  if (dateDecision === "illisible" || debutSaisi === "illisible" || finSaisie === "illisible") {
    return { ok: false, error: "Date illisible : saisissez-la au format JJ/MM/AAAA." };
  }
  const sourceDecision = sourceRetenue(s.dateDecision, p.dateDecision);
  let debut = debutSaisi;
  let sourceDebut = sourceRetenue(s.debut, p.debut);
  if (!debut && dateDecision) { debut = dateDecision; sourceDebut = sourceDecision; }
  let fin = finSaisie;
  let sourceFin = sourceRetenue(s.fin, p.fin);
  if (!fin && debut) { fin = finDeduite(debut); sourceFin = "DEDUITE"; }
  // Une fin tapée égale à début + 5 ans, sans fin lue, reste une déduction : c'est la règle, pas une lecture.
  if (fin && debut && sourceFin === "SAISIE" && !p.fin && fin.getTime() === finDeduite(debut).getTime()) sourceFin = "DEDUITE";
  if (fin && debut && fin.getTime() <= debut.getTime()) {
    return { ok: false, error: "La fin de validité doit suivre le début : corrigez l'une des deux dates (une DE vaut 5 ans)." };
  }
  if (!debut && !fin && !dateDecision && !s.numero) {
    return { ok: false, error: "Rien à enregistrer : indiquez au moins la date de la décision ou le début de validité." };
  }
  return {
    ok: true, numero: s.numero ? s.numero.trim().slice(0, 80) : null,
    dateDecision, sourceDecision: dateDecision ? sourceDecision : null,
    debut, sourceDebut: debut ? sourceDebut : null,
    fin, sourceFin: fin ? sourceFin : null,
  };
}
