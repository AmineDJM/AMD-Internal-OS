/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COÛT DE L'IA IMPUTÉ AU BUDGET INFORMATIQUE — les règles (Super Admin, 24/11/2026 : « le coût de l'IA imputé au budget
 * des départements »).
 *
 * LA SOURCE : le journal des appels de modèle (`ModelCallLog`, une ligne par appel payé, coût en dollars recalculé sur la
 * grille datée). Un appel sans tarif garde un coût INCONNU : il est compté à part (`sansTarif`), jamais pour zéro en silence.
 *
 * LA SOCIÉTÉ QUI PAIE : celle de la PERSONNE qui a demandé — sa fiche employé d'abord, à défaut la société de son
 * département ; la même règle que l'argent (`moneyEntityOf`, `lib/company.ts`). Un appel sans personne (tâche de fond) ou
 * d'une personne rattachée à aucune société n'est imputé NULLE PART : il est montré « non rattaché », avec son remède.
 *
 * LE MONTANT : dollars × taux USD → DZD fixé par qui impute (jamais un taux deviné), arrondi au centime.
 *
 * IDEMPOTENT par (société, mois) : rejouer le calcul ne crée rien de plus ; un montant changé met la ligne à jour.
 *
 * Module PUR, sans import : les écrans clients le lisent par `partage.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un agrégat du journal : une personne × une fonction IA, sur le mois. */
export interface AppelAgrege {
  userId: string | null;
  /** La fonction IA (« assistant_ia », « brain »…) ; nulle quand l'appel ne la déclare pas. */
  feature: string | null;
  /** Somme exacte des coûts connus, en dollars (chaîne décimale lue en base, ou nombre). */
  coutUsd: string | number;
  appels: number;
  sansTarif: number;
}

/** Ce que l'on sait d'une personne pour la rattacher. */
export interface RattachementPersonne {
  /** La société de sa fiche employé. */
  societeEmploye: string | null;
  /** La société de son département (organigramme). */
  societeDepartement: string | null;
  departementId: string | null;
  departementNom: string | null;
}

export interface LigneDetail { cle: string; libelle: string; microUsd: number; appels: number }

export interface PartSociete {
  companyId: string;
  microUsd: number;
  appels: number;
  sansTarif: number;
  parFonction: LigneDetail[];
  parDepartement: LigneDetail[];
}

export interface Repartition {
  parSociete: PartSociete[];
  nonRattache: { microUsd: number; appels: number; sansTarif: number; personnes: number; sansPersonne: number };
}

export const SANS_DEPARTEMENT = "—";

/** Le dollar en micro-dollars entiers : additionner des milliers de coûts sans dérive de virgule flottante. */
export function versMicroUsd(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
}

export const enUsd = (microUsd: number): number => microUsd / 1_000_000;

/** La société d'une personne — même ordre que l'argent : sa fiche, puis son département. */
export function societeDeLaPersonne(p: RattachementPersonne | undefined): string | null {
  return p?.societeEmploye ?? p?.societeDepartement ?? null;
}

const LIBELLE_FONCTION: Readonly<Record<string, string>> = {
  assistant: "Adam", assistant_ia: "Assistant IA", nudge: "Suggestions proactives", brain: "Adventum Brain",
  briefing: "Briefing direction", process_intel: "Process Intelligence", field_report: "Rapports terrain",
  voice: "Transcription vocale", voice_realtime: "Voix temps réel", site_web: "Rédaction du site web",
  lecture_pieces: "Lecture des pièces", conseil_pieces: "Rangement des pièces Ad & Pro", kpi: "KPI & bilans",
  voix_terrain: "Voix du terrain", produit_360: "Produits 360", budget_campagne: "Campagne budgétaire",
  influence: "Graphe d'influence", attestation_travail: "Attestation de travail", postes_luna: "Postes Ad & Pro",
  nature_depense: "Nature des dépenses", visite_pv_detection: "Pharmacovigilance des comptes rendus",
};

/** Le nom lisible d'une fonction IA ; une fonction inconnue garde son code, une fonction absente se dit. */
export function libelleFonctionIa(feature: string | null | undefined): string {
  if (!feature) return "Non précisée";
  return LIBELLE_FONCTION[feature] ?? feature;
}

function ajouter(table: Map<string, LigneDetail>, cle: string, libelle: string, microUsd: number, appels: number): void {
  const l = table.get(cle) ?? { cle, libelle, microUsd: 0, appels: 0 };
  l.microUsd += microUsd;
  l.appels += appels;
  table.set(cle, l);
}

const parCout = (a: LigneDetail, b: LigneDetail) => b.microUsd - a.microUsd || b.appels - a.appels || a.libelle.localeCompare(b.libelle, "fr");

/**
 * RÉPARTIR LE MOIS PAR SOCIÉTÉ — chaque agrégat va à la société de sa personne, avec son détail par fonction IA et par
 * département demandeur. Ce qui ne se rattache pas est compté à part, jamais réparti au prorata (ce serait inventer).
 */
export function repartirParSociete(appels: readonly AppelAgrege[], personnes: ReadonlyMap<string, RattachementPersonne>): Repartition {
  const societes = new Map<string, { part: PartSociete; fonctions: Map<string, LigneDetail>; departements: Map<string, LigneDetail> }>();
  const nonRattache = { microUsd: 0, appels: 0, sansTarif: 0, personnes: 0, sansPersonne: 0 };
  const personnesNonRattachees = new Set<string>();
  for (const a of appels) {
    const micro = versMicroUsd(a.coutUsd);
    const p = a.userId ? personnes.get(a.userId) : undefined;
    const societe = societeDeLaPersonne(p);
    if (!societe) {
      nonRattache.microUsd += micro;
      nonRattache.appels += a.appels;
      nonRattache.sansTarif += a.sansTarif;
      if (a.userId) personnesNonRattachees.add(a.userId);
      else nonRattache.sansPersonne += a.appels;
      continue;
    }
    let s = societes.get(societe);
    if (!s) {
      s = { part: { companyId: societe, microUsd: 0, appels: 0, sansTarif: 0, parFonction: [], parDepartement: [] }, fonctions: new Map(), departements: new Map() };
      societes.set(societe, s);
    }
    s.part.microUsd += micro;
    s.part.appels += a.appels;
    s.part.sansTarif += a.sansTarif;
    ajouter(s.fonctions, a.feature ?? "", libelleFonctionIa(a.feature), micro, a.appels);
    ajouter(s.departements, p?.departementId ?? SANS_DEPARTEMENT, p?.departementNom ?? "Sans département", micro, a.appels);
  }
  nonRattache.personnes = personnesNonRattachees.size;
  const parSociete = [...societes.values()].map(({ part, fonctions, departements }) => ({
    ...part,
    parFonction: [...fonctions.values()].sort(parCout),
    parDepartement: [...departements.values()].sort(parCout),
  }));
  parSociete.sort((a, b) => b.microUsd - a.microUsd || a.companyId.localeCompare(b.companyId));
  return { parSociete, nonRattache };
}

/** Le taux USD → DZD saisi : un nombre strictement positif et plausible, sinon `null` (on ne devine jamais un taux). */
export function lireTaux(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return null;
  return Math.round(n * 10_000) / 10_000;
}

/** Le montant en dinars, arrondi au centime. */
export function montantDzd(microUsd: number, taux: number): number {
  return Math.round((microUsd * taux) / 10_000) / 100;
}

export type GesteImputation = "CREER" | "METTRE_A_JOUR" | "INCHANGEE" | "RIEN";

/**
 * QUE FAIRE DE CE MOIS POUR CETTE SOCIÉTÉ — la règle qui rend l'imputation rejouable.
 *   • rien d'imputé et rien consommé : RIEN (pas de ligne à zéro qui encombre le budget) ;
 *   • rien d'imputé : CREER ;
 *   • déjà imputé, même coût, même taux, même montant, et la ligne de dépense toujours là : INCHANGEE ;
 *   • sinon : METTRE_A_JOUR (la même ligne, jamais une seconde) — y compris quand la ligne de dépense a été retirée à la main.
 */
export function gesteImputation(
  existante: { microUsd: number; taux: number; montantDzd: number; ligneExiste: boolean } | null,
  calcul: { microUsd: number; taux: number; montantDzd: number; appels: number },
): GesteImputation {
  if (!existante) return calcul.appels === 0 && calcul.microUsd === 0 ? "RIEN" : "CREER";
  const meme = existante.microUsd === calcul.microUsd && existante.taux === calcul.taux && existante.montantDzd === calcul.montantDzd;
  return meme && existante.ligneExiste ? "INCHANGEE" : "METTRE_A_JOUR";
}

/** Ce que l'imputation garde de son détail (JSON) : qui consomme, par fonction et par département. */
export interface DetailImputation {
  parFonction: { cle: string; libelle: string; coutUsd: number; appels: number }[];
  parDepartement: { cle: string; libelle: string; coutUsd: number; appels: number }[];
}

export function detailAStocker(part: PartSociete): DetailImputation {
  const versUsd = (l: LigneDetail) => ({ cle: l.cle, libelle: l.libelle, coutUsd: enUsd(l.microUsd), appels: l.appels });
  return { parFonction: part.parFonction.map(versUsd), parDepartement: part.parDepartement.map(versUsd) };
}

/** Relit un détail stocké (JSON venu de la base) sans jamais lever. */
export function lireDetail(v: unknown): DetailImputation {
  const lignes = (x: unknown) => (Array.isArray(x) ? x : []).flatMap((l) => {
    if (!l || typeof l !== "object") return [];
    const o = l as Record<string, unknown>;
    return [{ cle: String(o.cle ?? ""), libelle: String(o.libelle ?? ""), coutUsd: Number(o.coutUsd) || 0, appels: Number(o.appels) || 0 }];
  });
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { parFonction: lignes(o.parFonction), parDepartement: lignes(o.parDepartement) };
}
