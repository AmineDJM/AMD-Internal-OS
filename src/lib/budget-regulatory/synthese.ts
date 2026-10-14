/**
 * BUDGET REGULATORY — LA VUE D'ENSEMBLE ALLÉGÉE (Direction, 09/10) : les règles PURES des « Prochains BV » et de la
 * courbe de consommation prolongée par les BV 75 % attendus.
 *
 * Module sans valeur importée (seulement des types) : lu par l'écran serveur et testé. Aucune donnée inventée — un BV
 * dont on ne sait pas quand il tombera n'a pas de mois (« — »), et la courbe le dit plutôt que de le placer au hasard.
 */

import type { CelluleBv, LigneBv, NatureBv } from "./bv";

/** OÙ EN EST UN BV : à demander (le 75 % attendu) ou déjà demandé, chez les Finances. */
export type EtatProchainBv = "A_DEMANDER" | "DEMANDE";

export interface ProchainBv {
  dossierId: string;
  reference: string;
  /** Le produit : nom commercial, sinon DCI. */
  produit: string;
  nature: NatureBv;
  montant: number;
  /** « AAAA-MM » attendu, `null` quand aucune date ne le dit. */
  mois: string | null;
  etat: EtatProchainBv;
}

const MOIS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;

/** « AAAA-MM » (UTC) d'une date ISO ou d'un `Date` — `null` si absente ou illisible. */
export function moisDe(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** « 2026-11 » → « novembre » (« novembre 2026 » avec `avecAnnee`) ; « — » si le mois est inconnu. */
export function libelleMois(ym: string | null | undefined, avecAnnee = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym ?? "");
  if (!m) return "—";
  const nom = MOIS_LONGS[Number(m[2]) - 1];
  if (!nom) return "—";
  return avecAnnee ? `${nom} ${m[1]}` : nom;
}

/**
 * LES PROCHAINS BV — ce qui reste à demander ou à régler, dossier par dossier.
 *  • le 75 % ATTENDU (3 × le 25 % connu, pas encore demandé) : tombe au mois du DÉPÔT PRÉVU du dossier (il se paie avant) ;
 *  • un BV déjà DEMANDÉ et pas réglé : au mois de sa demande, « chez les Finances ».
 * Triés par mois (les sans-date à la fin), puis par référence.
 */
export function prochainsBv(lignes: readonly LigneBv[], depotPrevu: Readonly<Record<string, string | null>>): ProchainBv[] {
  const rows: ProchainBv[] = [];
  for (const l of lignes) {
    const base = { dossierId: l.dossierId, reference: l.reference, produit: l.nom ?? l.dci };
    if (l.bv25.statut === "DEMANDE" && l.bv25.demande > 0) {
      rows.push({ ...base, nature: "25", montant: l.bv25.demande, mois: moisDe(l.bv25.date), etat: "DEMANDE" });
    }
    if (l.bv75.statut === "DEMANDE" && l.bv75.demande > 0) {
      rows.push({ ...base, nature: "75", montant: l.bv75.demande, mois: moisDe(l.bv75.date), etat: "DEMANDE" });
    }
    if (l.prevision75 > 0) {
      rows.push({ ...base, nature: "75", montant: l.prevision75, mois: moisDe(depotPrevu[l.dossierId] ?? null), etat: "A_DEMANDER" });
    }
  }
  return rows.sort((a, b) => {
    if (a.mois !== b.mois) {
      if (a.mois === null) return 1;
      if (b.mois === null) return -1;
      return a.mois < b.mois ? -1 : 1;
    }
    return a.reference.localeCompare(b.reference, "fr") || a.nature.localeCompare(b.nature);
  });
}

/** LE BV 75 % À VENIR, en un chiffre : le montant attendu et le nombre de dossiers qui le portent. */
export function resumePrevision(lignes: readonly Pick<LigneBv, "prevision75">[]): { montant: number; dossiers: number } {
  let montant = 0;
  let dossiers = 0;
  for (const l of lignes) {
    if (l.prevision75 > 0) { montant += l.prevision75; dossiers += 1; }
  }
  return { montant, dossiers };
}

/** OÙ EN EST L'ANNÉE : la part de la période déjà écoulée, de 0 à 100 (entier). */
export function avancementPeriode(from: Date | string, to: Date | string, now: Date): number {
  const a = (typeof from === "string" ? new Date(from) : from).getTime();
  const b = (typeof to === "string" ? new Date(to) : to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round(Math.min(1, Math.max(0, (now.getTime() - a) / (b - a))) * 100);
}

export interface PointCumul { month: string; label: string; cumulative: number }
export interface PrevisionMensuelle { mois: string | null; montant: number }

export interface CourbeProjetee {
  labels: string[];
  /** Le cumul réel, jusqu'au mois en cours (puis `null`). */
  reel: (number | null)[];
  /** Le cumul prolongé des BV 75 % attendus, du mois en cours à la fin (avant : `null`). */
  projete: (number | null)[];
  /** Le mois en cours dans la série. */
  indexMaintenant: number;
  /** Les BV attendus sans mois connu : absents de la courbe, comptés ici. */
  nonDates: { nombre: number; montant: number };
}

/**
 * LA COURBE : consommation cumulée réelle jusqu'à aujourd'hui, puis — en pointillé — ce que les BV 75 % attendus y
 * ajouteront, mois par mois. Un BV attendu ce mois-ci ou avant (en retard) tombe au mois SUIVANT : ce qui est passé est
 * déjà dans le réel, ce qui n'est pas encore payé ne peut pas l'être. Un mois hors période est ramené à ses bornes.
 */
export function courbeProjection(points: readonly PointCumul[], previsions: readonly PrevisionMensuelle[], now: Date): CourbeProjetee {
  const n = points.length;
  const vide: CourbeProjetee = { labels: [], reel: [], projete: [], indexMaintenant: 0, nonDates: { nombre: 0, montant: 0 } };
  if (n === 0) return vide;

  const cle = moisDe(now) as string;
  let idx = points.findIndex((p) => p.month === cle);
  if (idx === -1) idx = cle < points[0].month ? 0 : n - 1;

  const ajouts = new Array<number>(n).fill(0);
  const nonDates = { nombre: 0, montant: 0 };
  for (const p of previsions) {
    if (!p.mois || !/^\d{4}-\d{2}$/.test(p.mois)) { nonDates.nombre += 1; nonDates.montant += p.montant; continue; }
    let i = points.findIndex((pt) => pt.month === p.mois);
    if (i === -1) i = p.mois < points[0].month ? 0 : n - 1;
    ajouts[Math.min(n - 1, Math.max(idx + 1, i))] += p.montant;
  }

  const base = points[idx].cumulative;
  let cumulAjouts = 0;
  const projete = points.map((_, i) => {
    cumulAjouts += ajouts[i];
    return i < idx ? null : base + cumulAjouts;
  });
  return {
    labels: points.map((p) => p.label),
    reel: points.map((p, i) => (i <= idx ? p.cumulative : null)),
    projete,
    indexMaintenant: idx,
    nonDates,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// LA VUE D'ENSEMBLE SIMPLIFIÉE (maquette validée, Direction 10/2026) : trois chiffres, une barre, deux cartes BV, le
// tableau des dossiers. « Beaucoup trop complexe » : la courbe, les catégories et les « Prochains BV » sont partis de
// l'écran (leurs règles ci-dessus restent, testées).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un compte et son montant (« 3 · 1 350 000 DA »). */
export interface CompteMontant { nombre: number; montant: number }

/** L'état d'un BV dans une ligne du tableau : payé, demandé (pas réglé), engagé (le 75 % attendu), ou rien. */
export type EtatBvSimple = "PAYE" | "DEMANDE" | "ENGAGE" | "AUCUN";

export interface DossierSimple {
  dossierId: string;
  reference: string;
  /** Le produit : nom commercial, sinon DCI. */
  produit: string;
  /** Le montant affiché (payé + demandé ; pour le 75 % encore attendu : la prévision). `null` = inconnu. */
  bv25: { montant: number | null; etat: EtatBvSimple };
  bv75: { montant: number | null; etat: EtatBvSimple };
  /** Les frais d'enregistrement du dossier : BV 25 % + BV 75 % (connu, sinon attendu). */
  fraisTotaux: number;
  /** Ce qui reste à payer : frais totaux − déjà payé (0 = soldé). */
  resteAPayer: number;
}

export interface SyntheseSimple {
  budget: number;
  consomme: number;
  engage: number;
  /** Budget − consommé − engagé (négatif = dépassement). */
  restant: number;
  engageDetail: {
    /** Ce que l'enveloppe compte déjà comme engagé (ordres émis non réglés, BV demandés compris). */
    enveloppe: number;
    /** Les BV demandés et pas réglés, lus dossier par dossier. */
    bvDemandes: number;
    /** Les BV 75 % attendus : 3 × le BV 25 % connu, tant que le 75 % n'est ni demandé ni payé. */
    bv75AVenir: number;
  };
  /** La barre, en % de sa base (le budget, ou consommé + engagé s'il le dépasse) : les trois font 100 (0 sans budget). */
  barre: { consomme: number; engage: number; libre: number };
  bv25: { payes: CompteMontant; demandes: CompteMontant; total: CompteMontant };
  bv75: { payes: CompteMontant; demandes: CompteMontant; aVenir: CompteMontant };
  dossiers: DossierSimple[];
}

const estPaye = (c: CelluleBv) => c.statut === "PAYE" || c.statut === "PAYE_SANS_MONTANT";
const etatDe = (c: CelluleBv): EtatBvSimple => (c.statut === "DEMANDE" ? "DEMANDE" : estPaye(c) ? "PAYE" : "AUCUN");
const part = (v: number, base: number) => (base > 0 ? Math.max(0, Math.min(100, (v / base) * 100)) : 0);

/**
 * LA SYNTHÈSE SIMPLE. La règle-clé : un BV 25 % ENGAGE TOUT LE DOSSIER — les frais d'enregistrement valent BV 25 % × 4,
 * donc dès qu'un BV 25 % existe (demandé ou payé), les 75 % restants (3 × BV 25 %, `prevision75`) sont ENGAGÉS — retirés
 * du restant — jusqu'au paiement du BV 75 %, qui les fait passer en consommé. Un BV demandé et pas réglé est engagé aussi.
 *
 * RAPPROCHEMENT AVEC L'ENVELOPPE (`getBudgetOverview`) — il ne peut pas être exact, d'où ces choix :
 *  • CONSOMMÉ = le consommé de l'ENVELOPPE, pas la somme des BV payés lus par dossier. C'est le chiffre que tous les
 *    autres écrans du budget affichent ; il compte aussi les BV saisis à la main sans dossier et toute autre dépense
 *    rangée dans l'enveloppe, et ne compte PAS un BV payé mais imputé ailleurs (« à ranger », page BV par dossier). Les
 *    cartes BV disent, elles, ce qui est payé dossier par dossier : les deux peuvent différer de ces écarts-là.
 *  • ENGAGÉ = l'engagé de l'enveloppe (ordres émis non réglés — un BV demandé naît rangé dans sa catégorie, il y est donc
 *    déjà) + les BV 75 % attendus, que l'enveloppe ne connaît pas. Si les BV demandés lus par dossier dépassent l'engagé
 *    de l'enveloppe (BV demandés imputés hors d'elle), on retient les BV demandés : un BV demandé est toujours engagé, et
 *    on ne le compte jamais deux fois.
 */
export function syntheseSimple(
  lignes: readonly LigneBv[],
  totaux: { total: number; consumed: number; committed: number },
): SyntheseSimple {
  const zero = (): CompteMontant => ({ nombre: 0, montant: 0 });
  const bv25 = { payes: zero(), demandes: zero(), total: zero() };
  const bv75 = { payes: zero(), demandes: zero(), aVenir: zero() };
  const ajoute = (c: CompteMontant, m: number) => { c.nombre += 1; c.montant += m; };
  const dossiers: DossierSimple[] = [];

  for (const l of lignes) {
    if (estPaye(l.bv25)) ajoute(bv25.payes, l.bv25.paye);
    if (l.bv25.demande > 0) ajoute(bv25.demandes, l.bv25.demande);
    if (l.bv25.statut !== "A_VENIR") ajoute(bv25.total, l.bv25.paye + l.bv25.demande);
    if (estPaye(l.bv75)) ajoute(bv75.payes, l.bv75.paye);
    if (l.bv75.demande > 0) ajoute(bv75.demandes, l.bv75.demande);
    if (l.prevision75 > 0) ajoute(bv75.aVenir, l.prevision75);

    const connu25 = l.bv25.paye + l.bv25.demande;
    const connu75 = l.bv75.paye + l.bv75.demande;
    const cellule75 = l.prevision75 > 0
      ? { montant: l.prevision75, etat: "ENGAGE" as const }
      : { montant: connu75 > 0 ? connu75 : null, etat: etatDe(l.bv75) };
    const fraisTotaux = connu25 + (cellule75.montant ?? 0);
    dossiers.push({
      dossierId: l.dossierId,
      reference: l.reference,
      produit: l.nom ?? l.dci,
      bv25: { montant: connu25 > 0 ? connu25 : null, etat: etatDe(l.bv25) },
      bv75: cellule75,
      fraisTotaux,
      resteAPayer: Math.max(0, fraisTotaux - l.bv25.paye - l.bv75.paye),
    });
  }

  const bvDemandes = bv25.demandes.montant + bv75.demandes.montant;
  const consomme = totaux.consumed;
  const engage = Math.max(totaux.committed, bvDemandes) + bv75.aVenir.montant;
  const base = Math.max(totaux.total, consomme + engage);
  const pConsomme = part(consomme, base);
  const pEngage = Math.min(100 - pConsomme, part(engage, base));

  return {
    budget: totaux.total,
    consomme,
    engage,
    restant: totaux.total - consomme - engage,
    engageDetail: { enveloppe: totaux.committed, bvDemandes, bv75AVenir: bv75.aVenir.montant },
    barre: { consomme: pConsomme, engage: pEngage, libre: base > 0 ? Math.max(0, 100 - pConsomme - pEngage) : 0 },
    bv25,
    bv75,
    dossiers,
  };
}
