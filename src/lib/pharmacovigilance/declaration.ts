import { A_DECLARER_PV, AVANT_EVALUATION_PV, type StatutPv } from "./regles";

/**
 * PHARMACOVIGILANCE — LA DÉCLARATION À L'AUTORITÉ ET SON DÉLAI (Super Admin, 24/11/2026). Règles PURES : l'échéance
 * selon la gravité, les paliers d'alerte, ce qu'exigent l'évaluation, la déclaration, l'accusé et le visa. Les écrans
 * (composants client compris), les actions serveur et le balayage des échéances les lisent tous.
 *
 * La déclaration se fait HORS plateforme (aucune transmission électronique à l'autorité : pas d'interface connue) ;
 * Regulatory l'enregistre ensuite ici, avec sa référence et sa pièce.
 */

// ─────────────────────────── L'évaluation ───────────────────────────

export const IMPUTABILITES_PV = ["CERTAINE", "PROBABLE", "POSSIBLE", "IMPROBABLE", "NON_EVALUABLE"] as const;
export type ImputabilitePv = (typeof IMPUTABILITES_PV)[number];

export const IMPUTABILITE_PV: Record<ImputabilitePv, string> = {
  CERTAINE: "Certaine",
  PROBABLE: "Probable",
  POSSIBLE: "Possible",
  IMPROBABLE: "Improbable",
  NON_EVALUABLE: "Non évaluable",
};

export function estImputabilitePv(v: string | null | undefined): v is ImputabilitePv {
  return !!v && (IMPUTABILITES_PV as readonly string[]).includes(v);
}

/** Oui / non d'un formulaire : « oui » | « non », sinon rien (une case non cochée n'est pas un « non »). */
export function lireOuiNonPv(v: string | null | undefined): boolean | null {
  return v === "oui" ? true : v === "non" ? false : null;
}

export interface SaisieEvaluationPv {
  grave: boolean | null;
  attendu: boolean | null;
  imputabilite: string | null;
  /** La date de connaissance corrigée (facultative). */
  dateConnaissance: Date | null;
}

/** Le refus d'une évaluation — ou `null`. Les trois jugements sont obligatoires ; la date de connaissance ne vient pas du futur. */
export function refusEvaluationPv(de: StatutPv, e: SaisieEvaluationPv, maintenant: Date): string | null {
  if (de === "CLOS") return "Le cas est clos : rouvrez-le avant de le réévaluer.";
  if (e.grave === null) return "Dites si le cas est grave ou non grave.";
  if (e.attendu === null) return "Dites si l'effet est attendu (décrit dans la notice) ou inattendu.";
  if (!estImputabilitePv(e.imputabilite)) return "Choisissez l'imputabilité.";
  if (e.dateConnaissance && jourAlgerPv(e.dateConnaissance) > jourAlgerPv(maintenant)) {
    return "La date de connaissance ne peut pas être dans le futur.";
  }
  return null;
}

/** Une évaluation fait passer un cas d'avant l'évaluation à « Évalué » ; plus loin dans le circuit, il reste où il est. */
export function statutApresEvaluationPv(de: StatutPv): StatutPv {
  return AVANT_EVALUATION_PV.includes(de) ? "EVALUE" : de;
}

// ─────────────────────────── Le délai ───────────────────────────

export interface DelaisPv {
  /** Jours calendaires pour un cas grave. */
  graveJours: number;
  /** Jours calendaires pour un cas non grave. */
  nonGraveJours: number;
}

/**
 * LES DÉLAIS PAR DÉFAUT — pré-réglés sur les usages courants de pharmacovigilance (15 jours calendaires pour un cas
 * grave, 90 pour un cas non grave). Ils NE SONT PAS une lecture certaine du droit algérien : le Super Admin les règle,
 * après confirmation par le pharmacien responsable.
 */
export const DELAIS_PV_DEFAUT: DelaisPv = { graveJours: 15, nonGraveJours: 90 };
export const AVERTISSEMENT_DELAIS_PV = "À confirmer par le pharmacien responsable / la réglementation algérienne en vigueur.";
export const BORNES_DELAI_PV = { min: 1, max: 365 } as const;

export function refusDelaisPv(d: { graveJours: number | null; nonGraveJours: number | null }): string | null {
  const ok = (n: number | null) => n !== null && Number.isInteger(n) && n >= BORNES_DELAI_PV.min && n <= BORNES_DELAI_PV.max;
  if (!ok(d.graveJours) || !ok(d.nonGraveJours)) return `Chaque délai est un nombre entier de jours, entre ${BORNES_DELAI_PV.min} et ${BORNES_DELAI_PV.max}.`;
  if (d.graveJours! > d.nonGraveJours!) return "Le délai d'un cas grave ne peut pas dépasser celui d'un cas non grave.";
  return null;
}

export type SourceGravitePv = "EVALUATION" | "SIGNALEMENT" | "PRUDENCE";

/**
 * LA GRAVITÉ QUI FIXE LE DÉLAI : celle de l'évaluation ; avant elle, celle du signalement (grave ou décès → grave,
 * non grave → non grave) ; inconnue, le délai le PLUS COURT — attendre l'évaluation pour découvrir qu'on est en
 * retard serait l'erreur la plus chère.
 */
export function graviteDuDelaiPv(cas: { evalGrave: boolean | null; severity: string | null }): { grave: boolean; source: SourceGravitePv } {
  if (cas.evalGrave !== null) return { grave: cas.evalGrave, source: "EVALUATION" };
  if (cas.severity === "GRAVE" || cas.severity === "DECES") return { grave: true, source: "SIGNALEMENT" };
  if (cas.severity === "NON_GRAVE") return { grave: false, source: "SIGNALEMENT" };
  return { grave: true, source: "PRUDENCE" };
}

const MS_JOUR = 86_400_000;

/** Le jour civil d'Alger d'un instant, « AAAA-MM-JJ » (les délais se comptent en jours calendaires, heure d'Alger). */
export function jourAlgerPv(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Algiers" });
}

function jourEnMs(jour: string): number {
  const [a, m, j] = jour.split("-").map(Number);
  return Date.UTC(a, m - 1, j);
}

export function ajouterJoursPv(jour: string, n: number): string {
  return new Date(jourEnMs(jour) + n * MS_JOUR).toISOString().slice(0, 10);
}

/** Jours calendaires de `de` à `a` (positif quand `a` est après). */
export function ecartJoursPv(de: string, a: string): number {
  return Math.round((jourEnMs(a) - jourEnMs(de)) / MS_JOUR);
}

/** « 2026-12-09 » → « 09/12/2026 ». */
export function jourFrPv(jour: string): string {
  const [a, m, j] = jour.split("-");
  return `${j}/${m}/${a}`;
}

export interface EcheancePv {
  /** Le dernier jour pour déclarer, « AAAA-MM-JJ » (heure d'Alger). */
  jour: string;
  grave: boolean;
  source: SourceGravitePv;
  delaiJours: number;
}

/** L'ÉCHÉANCE DE DÉCLARATION : jour de connaissance + délai de la gravité retenue. */
export function echeanceDeclarationPv(
  cas: { dateConnaissance: Date; evalGrave: boolean | null; severity: string | null },
  delais: DelaisPv,
): EcheancePv {
  const { grave, source } = graviteDuDelaiPv(cas);
  const delaiJours = grave ? delais.graveJours : delais.nonGraveJours;
  return { jour: ajouterJoursPv(jourAlgerPv(cas.dateConnaissance), delaiJours), grave, source, delaiJours };
}

/** La déclaration est encore à faire : le cas n'est ni déclaré ni clos. */
export function attendDeclarationPv(cas: { status: string; declareLe: Date | null }): boolean {
  return cas.declareLe === null && (A_DECLARER_PV as readonly string[]).includes(cas.status);
}

// ─────────────────────────── Les paliers d'alerte ───────────────────────────

export const PALIERS_PV = ["J5", "J2", "J0", "DEPASSE"] as const;
export type PalierPv = (typeof PALIERS_PV)[number];

const RANG: Record<PalierPv, number> = { J5: 1, J2: 2, J0: 3, DEPASSE: 4 };

/** Le palier du jour : J-5 (5 jours ou moins), J-2, le jour J, puis le dépassement — rien avant J-5. */
export function palierPv(joursRestants: number): PalierPv | null {
  if (joursRestants < 0) return "DEPASSE";
  if (joursRestants === 0) return "J0";
  if (joursRestants <= 2) return "J2";
  if (joursRestants <= 5) return "J5";
  return null;
}

/**
 * LE PALIER À ANNONCER : seulement en ENTRANT dans un palier plus avancé que le dernier annoncé — une alerte par
 * palier, jamais une par jour (une notification quotidienne se coupe, et l'on rate la vraie). Un cas découvert déjà en
 * retard reçoit une seule alerte : le dépassement.
 */
export function palierAAlerterPv(courant: PalierPv | null, dernier: string | null | undefined): PalierPv | null {
  if (!courant) return null;
  const rangDernier = dernier && dernier in RANG ? RANG[dernier as PalierPv] : 0;
  return RANG[courant] > rangDernier ? courant : null;
}

export interface EtatEcheancePv extends EcheancePv {
  joursRestants: number;
  palier: PalierPv | null;
  libelle: string;
  ton: "neutral" | "warning" | "danger";
}

/** L'état du délai d'un cas à déclarer — `null` quand la déclaration n'est plus à faire. */
export function etatEcheancePv(
  cas: { status: string; declareLe: Date | null; dateConnaissance: Date; evalGrave: boolean | null; severity: string | null },
  delais: DelaisPv,
  maintenant: Date,
): EtatEcheancePv | null {
  if (!attendDeclarationPv(cas)) return null;
  const e = echeanceDeclarationPv(cas, delais);
  const joursRestants = ecartJoursPv(jourAlgerPv(maintenant), e.jour);
  const palier = palierPv(joursRestants);
  const date = jourFrPv(e.jour);
  const libelle = joursRestants < 0
    ? `Déclaration en retard de ${-joursRestants} j (échéance ${date})`
    : joursRestants === 0
      ? `À déclarer aujourd'hui (${date})`
      : `À déclarer avant le ${date} (${joursRestants} j)`;
  return { ...e, joursRestants, palier, libelle, ton: palier === "DEPASSE" || palier === "J0" ? "danger" : palier ? "warning" : "neutral" };
}

// ─────────────────────────── La déclaration, l'accusé, le visa ───────────────────────────

export interface SaisieDeclarationPv {
  declareLe: Date | null;
  reference: string | null;
  /** Une pièce est jointe (la fiche envoyée, le courrier, la capture de l'envoi). */
  piece: boolean;
  accuseLe: Date | null;
}

/** Le refus d'un enregistrement de déclaration — ou `null`. */
export function refusDeclarationPv(
  cas: { status: StatutPv; evalue: boolean; dateConnaissance: Date },
  d: SaisieDeclarationPv,
  maintenant: Date,
): string | null {
  if (cas.status === "CLOS") return "Le cas est clos : rouvrez-le avant d'enregistrer une déclaration.";
  if (cas.status === "DECLARE" || cas.status === "SUIVI") return "La déclaration est déjà enregistrée : ajoutez l'accusé ou les informations de suivi.";
  if (!cas.evalue) return "Évaluez le cas (gravité, caractère attendu, imputabilité) avant d'enregistrer sa déclaration.";
  if (!d.declareLe) return "Indiquez la date à laquelle la déclaration a été envoyée à l'autorité.";
  const jour = jourAlgerPv(d.declareLe);
  if (jour > jourAlgerPv(maintenant)) return "La date de déclaration ne peut pas être dans le futur.";
  if (jour < jourAlgerPv(cas.dateConnaissance)) return "La date de déclaration précède la connaissance du cas : vérifiez-la.";
  if (!(d.reference ?? "").trim()) return "Indiquez la référence de la déclaration (numéro attribué ou référence de votre envoi).";
  if (!d.piece) return "Joignez la pièce de la déclaration (fiche envoyée, courrier ou preuve d'envoi).";
  if (d.accuseLe) return refusDateAccusePv(d.declareLe, d.accuseLe, maintenant);
  return null;
}

function refusDateAccusePv(declareLe: Date, accuseLe: Date, maintenant: Date): string | null {
  if (jourAlgerPv(accuseLe) > jourAlgerPv(maintenant)) return "La date de l'accusé ne peut pas être dans le futur.";
  if (jourAlgerPv(accuseLe) < jourAlgerPv(declareLe)) return "L'accusé ne peut pas précéder la déclaration.";
  return null;
}

/** Le refus d'un accusé de réception — ou `null`. Il suit une déclaration enregistrée. */
export function refusAccusePv(cas: { status: StatutPv; declareLe: Date | null }, accuseLe: Date | null, maintenant: Date): string | null {
  if (!cas.declareLe || (cas.status !== "DECLARE" && cas.status !== "SUIVI")) return "Enregistrez d'abord la déclaration à l'autorité.";
  if (!accuseLe) return "Indiquez la date de l'accusé de réception.";
  return refusDateAccusePv(cas.declareLe, accuseLe, maintenant);
}

/**
 * LES PHARMACIENS RESPONSABLES DÉSIGNÉS (réglage du Super Admin, { companyId: userId }) relus sans confiance : seules
 * les paires texte → texte non vides comptent.
 */
export function lireDesignationsPv(brut: unknown): Record<string, string> {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(brut as Record<string, unknown>)) if (k && typeof v === "string" && v) out[k] = v;
  return out;
}

/**
 * QUI VISE LA DÉCLARATION D'UN CAS : le pharmacien responsable désigné pour la société du produit. Société inconnue
 * (produit hors catalogue) : n'importe lequel des pharmaciens désignés. Aucun désigné : pas de visa attendu.
 */
export function viseursDuCasPv(designations: Record<string, string>, companyId: string | null): string[] {
  if (companyId) return designations[companyId] ? [designations[companyId]] : [];
  return [...new Set(Object.values(designations))];
}

/** Le refus d'un visa — ou `null`. */
export function refusVisaPv(cas: { status: StatutPv; declareLe: Date | null; visaPharmacienLe: Date | null }, viseurs: readonly string[], userId: string): string | null {
  if (!viseurs.includes(userId)) return "Seul le pharmacien responsable désigné pour cette société vise la déclaration.";
  if (!cas.declareLe || (cas.status !== "DECLARE" && cas.status !== "SUIVI")) return "La déclaration n'est pas encore enregistrée : le visa vient après.";
  if (cas.visaPharmacienLe) return "La déclaration est déjà visée.";
  return null;
}
