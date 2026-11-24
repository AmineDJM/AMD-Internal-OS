import { montantRetenu, type LigneDecidee } from "./regles";
import { CLE_MS_CNAS, CLE_MS_IRG, controleCoutEmployeur, repartirSelonProfil, type ControleCoutEmployeur, type RetenuesMensuelles } from "./masse-salariale";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE BUDGÉTAIRE — LE VOLET « IMPÔTS & TAXES » ET LE RÉSULTAT PRÉVISIONNEL (Super Admin, 24/11/2026).
 *
 * « La TVA nette reversée à l'État et les impôts de fin d'année doivent être DANS LE BUDGET. » Le volet se cale sur
 * l'enveloppe « Impôts & taxes », qui porte DEUX lignes, et deux seulement (décisions de l'audit des dépenses) :
 *   • TVA_NETTE = TVA collectée sur les ventes prévues − TVA déductible sur les achats prévus, par société et par mois.
 *                 Chaque ligne porte son taux (19 %, 9 %, 0 %) ; les ventes sont prévues HT, les achats restent au
 *                 montant du budget (TTC) et leur TVA s'en extrait : TTC × t / (100 + t) ;
 *   • IBS       = résultat prévisionnel avant impôt × taux d'IBS de la société, réparti en acomptes + solde.
 * L'IRG et la CNAS ne sont PAS ici : ils font partie de la masse salariale (`masse-salariale.ts`, lignes `MS_IRG` /
 * `MS_CNAS` des pôles). Le Super Admin et la DG peuvent AJUSTER chaque montant calculé (le calcul reste à côté).
 *
 * LE RÉSULTAT : ventes HT − achats HT (TTC moins leur TVA) = résultat avant impôt ; − IBS = résultat net. La TVA n'est
 * PAS une charge : c'est un flux de caisse, montré dans la trésorerie (« TVA à reverser », crédit reporté d'un mois sur
 * l'autre) et dans l'enveloppe Impôts & taxes, jamais en déduction du résultat.
 *
 * LES TAUX : un seul endroit (`PARAMETRES_IMPOTS_DEFAUT`), réglable par campagne et par société, préréglé et marqué
 * « à confirmer par le cabinet » tant que personne ne l'a confirmé.
 *
 * Module PUR (aucune base) : lu par les écrans clients, les requêtes, les actions, et testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { CODE_ENVELOPPE_IMPOTS, LIGNES_BUDGET_IMPOTS } from "@/modules/finances/partage";

// ─────────────────────────────── Les clés (enveloppe du lot « impôts ») ───────────────────────────────

/** La clé de l'enveloppe Impôts & taxes — celle du module Finances, qui la crée et y impute les paiements. */
export const ENVELOPPE_IMPOTS_TAXES = CODE_ENVELOPPE_IMPOTS;

/** Les clés stables des lignes de l'enveloppe — celles du module Finances. */
export const CLES_IMPOTS = [LIGNES_BUDGET_IMPOTS.TVA_NETTE, LIGNES_BUDGET_IMPOTS.IBS] as const;
export type CleImpot = (typeof CLES_IMPOTS)[number];

export const LIBELLE_IMPOT: Record<CleImpot, string> = {
  TVA_NETTE: "TVA nette",
  IBS: "IBS",
};

export const estCleImpot = (v: unknown): v is CleImpot => typeof v === "string" && (CLES_IMPOTS as readonly string[]).includes(v);

/** Le « mois » 13 : ce qui se paie sur l'exercice suivant (le solde d'IBS). */
export const MOIS_EXERCICE_SUIVANT = 13;

// ─────────────────────────────── Les taux ───────────────────────────────

/** Les taux de TVA algériens admis, en % (les mêmes que `TAUX_TVA_ADMIS` de la fabrique, en fraction — un test les compare). */
export const TAUX_TVA_PCT: readonly number[] = [0, 9, 19];

export const NATURES_TVA = ["RECETTES", "DEPENSES", "MASSE_SALARIALE", "VERSEMENTS_ETAT"] as const;
export type NatureTva = (typeof NATURES_TVA)[number];
export const LIBELLE_NATURE_TVA: Record<NatureTva, string> = {
  RECETTES: "Ventes",
  DEPENSES: "Achats",
  MASSE_SALARIALE: "Masse salariale",
  VERSEMENTS_ETAT: "Versements à l'État (BV)",
};

export interface EcheanceIbs { mois: number; pct: number; exerciceSuivant: boolean }

export interface ParametresImpots {
  /** Le taux de TVA par défaut de chaque nature de ligne (en %) — pour un achat, le taux CONTENU dans son TTC. */
  tvaParNature: Record<NatureTva, number>;
  /** Le taux d'IBS d'une société sans réglage propre (en %). */
  ibsTauxDefaut: number;
  /** Le taux d'IBS par société (id → %). */
  ibsParSociete: Record<string, number>;
  /** Le calendrier : acomptes et solde (mois 1-12, et l'exercice suivant pour le solde). La somme fait 100 %. */
  calendrierIbs: EcheanceIbs[];
  /** Faux tant que le cabinet n'a pas confirmé ces taux : l'écran le dit. */
  confirmesParCabinet: boolean;
}

/**
 * LES PRÉRÉGLAGES — À CONFIRMER PAR LE CABINET (l'écran le dit tant que `confirmesParCabinet` est faux). TVA 19 % (taux
 * normal) par défaut sur les ventes et dans les achats, 0 % sur la masse salariale et les versements à l'État ; IBS 26 %
 * (activités autres que production et BTP) ; trois acomptes de 30 % (mars, juin, novembre) et le solde de 10 % en mai
 * de l'exercice suivant.
 */
export const PARAMETRES_IMPOTS_DEFAUT: ParametresImpots = {
  tvaParNature: { RECETTES: 19, DEPENSES: 19, MASSE_SALARIALE: 0, VERSEMENTS_ETAT: 0 },
  ibsTauxDefaut: 26,
  ibsParSociete: {},
  calendrierIbs: [
    { mois: 3, pct: 30, exerciceSuivant: false },
    { mois: 6, pct: 30, exerciceSuivant: false },
    { mois: 11, pct: 30, exerciceSuivant: false },
    { mois: 5, pct: 10, exerciceSuivant: true },
  ],
  confirmesParCabinet: false,
};

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pct = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

/** Les paramètres d'une campagne, lus du JSON stocké : ce qui manque ou est illisible reprend le préréglage. */
export function lireParametresImpots(brut: unknown): ParametresImpots {
  const d = PARAMETRES_IMPOTS_DEFAUT;
  if (!estObjet(brut)) return structuredClone(d);
  const tva = estObjet(brut.tvaParNature) ? brut.tvaParNature : {};
  const tvaParNature = Object.fromEntries(NATURES_TVA.map((n) => {
    const v = pct(tva[n]);
    return [n, v !== null && TAUX_TVA_PCT.includes(v) ? v : d.tvaParNature[n]];
  })) as Record<NatureTva, number>;
  const ibsParSociete: Record<string, number> = {};
  if (estObjet(brut.ibsParSociete)) for (const [k, v] of Object.entries(brut.ibsParSociete)) { const t = pct(v); if (t !== null) ibsParSociete[k] = t; }
  const cal = Array.isArray(brut.calendrierIbs)
    ? brut.calendrierIbs.filter(estObjet).map((e) => ({ mois: Number(e.mois), pct: Number(e.pct), exerciceSuivant: e.exerciceSuivant === true }))
    : null;
  return {
    tvaParNature,
    ibsTauxDefaut: pct(brut.ibsTauxDefaut) ?? d.ibsTauxDefaut,
    ibsParSociete,
    calendrierIbs: cal && verifierCalendrierIbs(cal).ok ? cal : structuredClone(d.calendrierIbs),
    confirmesParCabinet: brut.confirmesParCabinet === true,
  };
}

/** La TVA CONTENUE dans un montant TTC : TTC × t / (100 + t). */
export function tvaContenueDansTtc(ttc: number, tauxPct: number): number {
  if (!(ttc > 0) || !(tauxPct > 0)) return 0;
  return r2((ttc * tauxPct) / (100 + tauxPct));
}

/** Un calendrier d'IBS tient : des mois de 1 à 12, des parts positives, 100 % en tout. */
export function verifierCalendrierIbs(cal: readonly EcheanceIbs[]): { ok: true } | { ok: false; raison: string } {
  if (cal.length === 0) return { ok: false, raison: "Le calendrier de l'IBS est vide : indiquez au moins une échéance." };
  for (const e of cal) {
    if (!Number.isInteger(e.mois) || e.mois < 1 || e.mois > 12) return { ok: false, raison: "Chaque échéance de l'IBS tombe un mois de 1 à 12." };
    if (!(Number.isFinite(e.pct) && e.pct > 0)) return { ok: false, raison: "Chaque échéance de l'IBS porte une part positive." };
  }
  const total = Math.round(cal.reduce((a, e) => a + e.pct, 0) * 100) / 100;
  return total === 100 ? { ok: true } : { ok: false, raison: `Les échéances de l'IBS font ${String(total).replace(".", ",")} % : il faut 100 %.` };
}

/** « 3:30, 6:30, 11:30, 5:10+ » ⇄ calendrier (« + » = exercice suivant) — la forme d'un champ de saisie. */
export function calendrierEnTexte(cal: readonly EcheanceIbs[]): string {
  return cal.map((e) => `${e.mois}:${String(e.pct).replace(".", ",")}${e.exerciceSuivant ? "+" : ""}`).join(", ");
}
export function lireCalendrierTexte(texte: string): EcheanceIbs[] | null {
  const morceaux = texte.split(/[;,]\s*(?=\d)/).map((s) => s.trim()).filter(Boolean);
  const cal: EcheanceIbs[] = [];
  for (const m of morceaux) {
    const r = /^(\d{1,2})\s*:\s*(\d+(?:[.,]\d+)?)\s*(\+)?$/.exec(m);
    if (!r) return null;
    cal.push({ mois: Number(r[1]), pct: Number(r[2]!.replace(",", ".")), exerciceSuivant: r[3] === "+" });
  }
  return cal;
}

export function tauxIbsDeLaSociete(p: ParametresImpots, companyId: string): number {
  return p.ibsParSociete[companyId] ?? p.ibsTauxDefaut;
}

/** Les clés de catégorie de la masse salariale (net + primes, et ses sous-lignes IRG et CNAS). */
export const CLES_MASSE_SALARIALE: readonly string[] = ["MASSE_SALARIALE", "MASSE_SALARIALE_FDV", CLE_MS_IRG, CLE_MS_CNAS];

/** La nature d'une ligne de dépense : la paie et les recrutements sont de la masse salariale, les BV des versements à l'État. */
export function natureDeLaDepense(l: { source: string; categoryKey: string | null }): NatureTva {
  if (l.source === "AUTO_PAIE" || l.source === "AUTO_RECRUTEMENT" || (l.categoryKey !== null && CLES_MASSE_SALARIALE.includes(l.categoryKey))) return "MASSE_SALARIALE";
  if (l.source === "AUTO_BV" || l.categoryKey === "BV_25" || l.categoryKey === "BV_75") return "VERSEMENTS_ETAT";
  return "DEPENSES";
}

/** Le taux d'une ligne : le sien s'il est réglé, sinon celui de sa nature. */
export function tauxTvaDeLaLigne(propre: number | null | undefined, nature: NatureTva, p: ParametresImpots): number {
  return propre !== null && propre !== undefined && Number.isFinite(propre) ? propre : p.tvaParNature[nature];
}

/**
 * LE MONTANT PRÉVU D'UNE LIGNE DE DÉPENSE selon l'état de sa proposition : refusée → rien ; acceptée → le retenu
 * (ajusté, refusé ligne à ligne) ; encore en cours → le demandé (c'est la meilleure prévision du moment).
 */
export function montantPrevuDeLaLigne(statutProposition: string, l: LigneDecidee): number {
  if (statutProposition === "REFUSE") return 0;
  if (statutProposition === "ACCEPTE" || statutProposition === "ACCEPTE_AVEC_AJUSTEMENTS") return montantRetenu(l);
  return Math.max(0, l.propose);
}

// ─────────────────────────────── Le calcul ───────────────────────────────

/**
 * Un achat prévu (annuel, TTC — le montant du budget) : il se répartit selon son profil (les primes au mois de leur versement), sinon en
 * douzièmes. `companyId` nul = non rattachée à une société.
 */
export interface DepensePrevue {
  companyId: string | null; montant: number; nature: NatureTva; tvaPct: number | null; profil?: readonly number[] | null;
  /** La clé de catégorie (sert à lire la masse salariale en trois : net + primes, `MS_IRG`, `MS_CNAS`). */
  categoryKey?: string | null;
}
/** Une vente prévue (mensuelle, HT). */
export interface RecettePrevueTva { companyId: string; mois: number; montant: number; tvaPct: number | null }
/** Un montant posé à la main (ajustement ou saisie directe) — mois 1-12, ou 13 pour l'exercice suivant. */
export interface AjustementImpot { companyId: string; mois: number; cle: CleImpot; montant: number; calcule: number | null }

export interface CelluleImpot {
  /** Le calcul (nul = rien à calculer : saisie directe). */
  calcule: number | null;
  /** Ce qui compte : l'ajustement s'il existe, sinon le calcul, sinon 0. */
  retenu: number;
  ajuste: boolean;
}

export interface PrevisionSociete {
  /** Nul = dépenses de départements rattachés à aucune société. */
  companyId: string | null;
  recettesHT: number[];
  /** Les achats HT : le TTC du budget moins la TVA qu'il contient. */
  depenses: number[];
  resultatAvantImpot: number[];
  tvaCollectee: number[];
  tvaDeductible: number[];
  /** Les deux lignes de l'enveloppe, sur 13 colonnes (12 mois + exercice suivant). */
  impots: Record<CleImpot, CelluleImpot[]>;
  /** La TVA réellement à reverser chaque mois : un crédit (TVA nette négative) se reporte sur les mois suivants. */
  tvaAReverser: number[];
  creditTvaFinDAnnee: number;
  /** La masse salariale prévue de l'année, affichée en trois : net + primes, IRG, CNAS. */
  masseSalariale: { netEtPrimes: number; irg: number; cnas: number; total: number };
  /** Net + primes + IRG + CNAS face au coût employeur des fiches (nul : aucune fiche). */
  controleMasseSalariale: ControleCoutEmployeur | null;
  /** Résultat avant impôt − IBS, sur 13 colonnes (le solde d'IBS de l'exercice suivant en 13e). */
  resultatNet: number[];
  totaux: {
    recettesHT: number; depenses: number; resultatAvantImpot: number; ibs: number; resultatNet: number;
    tvaNette: number; tvaAReverser: number; masseSalariale: number;
    /** L'enveloppe Impôts & taxes de l'année : TVA à reverser + IBS payé dans l'année. */
    enveloppeImpotsTaxes: number;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const zeros = (n: number) => Array.from({ length: n }, () => 0);
const somme = (xs: readonly number[]) => r2(xs.reduce((a, x) => a + x, 0));

/** L'IBS annuel réparti selon le calendrier, sur 13 colonnes ; le dernier versement absorbe l'arrondi. */
export function repartirIbs(ibsAnnuel: number, cal: readonly EcheanceIbs[]): number[] {
  const out = zeros(13);
  if (!(ibsAnnuel > 0) || cal.length === 0) return out;
  let reste = Math.round(ibsAnnuel * 100);
  cal.forEach((e, i) => {
    const centimes = i === cal.length - 1 ? reste : Math.round((ibsAnnuel * 100 * e.pct) / 100);
    reste -= centimes;
    const col = e.exerciceSuivant ? MOIS_EXERCICE_SUIVANT - 1 : e.mois - 1;
    out[col] = r2(out[col]! + centimes / 100);
  });
  return out;
}

/** Le report de crédit : chaque mois, la TVA nette s'ajoute au crédit restant ; on ne reverse que le positif. */
export function tvaAReverserAvecReport(nette: readonly number[]): { mois: number[]; creditFinal: number } {
  let credit = 0;
  const mois = nette.map((n) => {
    const solde = r2(n - credit);
    if (solde > 0) { credit = 0; return solde; }
    credit = r2(-solde);
    return 0;
  });
  return { mois, creditFinal: credit };
}

/**
 * LES PRÉVISIONS D'UNE CAMPAGNE, société par société : ventes HT et achats HT par mois, résultat, TVA, IBS (calcul et
 * ajustements), résultat net, masse salariale en trois. `societes` fixe l'ordre ; une société citée par une ligne mais
 * absente de la liste est ajoutée à la fin. Les achats non rattachés forment une ligne à part (`companyId` nul), sans
 * IBS. `retenues` : les retenues MENSUELLES des fiches salariés de chaque société (pour le contrôle du coût employeur).
 */
export function calculerPrevisions(entree: {
  societes: readonly string[];
  recettes: readonly RecettePrevueTva[];
  depenses: readonly DepensePrevue[];
  parametres: ParametresImpots;
  ajustements: readonly AjustementImpot[];
  retenues?: Readonly<Record<string, RetenuesMensuelles>>;
}): PrevisionSociete[] {
  const p = entree.parametres;
  const ids: (string | null)[] = [...entree.societes];
  for (const id of [...entree.recettes.map((r) => r.companyId), ...entree.depenses.map((d) => d.companyId)]) if (!ids.includes(id)) ids.push(id);
  const ordre = [...ids.filter((x): x is string => x !== null), ...(ids.includes(null) ? [null] : [])];

  return ordre.map((companyId) => {
    const recettesHT = zeros(12), tvaCollectee = zeros(12), depenses = zeros(12), tvaDeductible = zeros(12);
    for (const r of entree.recettes) {
      if (r.companyId !== companyId || !(r.mois >= 1 && r.mois <= 12)) continue;
      const i = r.mois - 1;
      recettesHT[i] = r2(recettesHT[i]! + r.montant);
      tvaCollectee[i] = r2(tvaCollectee[i]! + (r.montant * tauxTvaDeLaLigne(r.tvaPct, "RECETTES", p)) / 100);
    }
    const masse = { netEtPrimes: 0, irg: 0, cnas: 0, total: 0 };
    for (const d of entree.depenses) {
      if (d.companyId !== companyId) continue;
      // Le montant du budget est TTC : sa TVA s'en extrait au taux de la ligne, le reste est la charge HT.
      const tva = tvaContenueDansTtc(d.montant, tauxTvaDeLaLigne(d.tvaPct, d.nature, p));
      const ht = repartirSelonProfil(r2(d.montant - tva), d.profil);
      const tvaMois = repartirSelonProfil(tva, d.profil);
      for (let i = 0; i < 12; i++) { depenses[i] = r2(depenses[i]! + ht[i]!); tvaDeductible[i] = r2(tvaDeductible[i]! + tvaMois[i]!); }
      if (d.nature === "MASSE_SALARIALE") {
        if (d.categoryKey === CLE_MS_IRG) masse.irg = r2(masse.irg + d.montant);
        else if (d.categoryKey === CLE_MS_CNAS) masse.cnas = r2(masse.cnas + d.montant);
        else masse.netEtPrimes = r2(masse.netEtPrimes + d.montant);
        masse.total = r2(masse.total + d.montant);
      }
    }
    const resultatAvantImpot = recettesHT.map((x, i) => r2(x - depenses[i]!));
    const raiAnnuel = somme(resultatAvantImpot);
    const ret = companyId ? entree.retenues?.[companyId] : undefined;

    const calcul: Record<CleImpot, (number | null)[]> = {
      TVA_NETTE: [...tvaCollectee.map((c, i) => r2(c - tvaDeductible[i]!)), null],
      IBS: companyId === null ? Array.from({ length: 13 }, () => null) : repartirIbs(r2((Math.max(0, raiAnnuel) * tauxIbsDeLaSociete(p, companyId)) / 100), p.calendrierIbs),
    };
    const impots = Object.fromEntries(CLES_IMPOTS.map((cle) => [cle, calcul[cle].map((c, i) => {
      const a = companyId === null ? undefined : entree.ajustements.find((x) => x.companyId === companyId && x.cle === cle && x.mois === i + 1);
      return { calcule: c, retenu: a ? r2(a.montant) : (c ?? 0), ajuste: Boolean(a) };
    })])) as Record<CleImpot, CelluleImpot[]>;

    const nette = impots.TVA_NETTE.slice(0, 12).map((c) => c.retenu);
    const { mois: tvaAReverser, creditFinal } = tvaAReverserAvecReport(nette);
    const ibs = impots.IBS.map((c) => c.retenu);
    const resultatNet = [...resultatAvantImpot.map((x, i) => r2(x - ibs[i]!)), r2(-ibs[12]!)];
    const controleMasseSalariale = ret && ret.salaries > 0
      ? controleCoutEmployeur({
        masseNette: masse.netEtPrimes, primes: Math.max(0, r2(masse.netEtPrimes - ret.net * 12)),
        irg: masse.irg, cnas: masse.cnas, coutEmployeurFiches: r2(ret.coutEmployeur * 12),
      })
      : null;
    return {
      companyId, recettesHT, depenses, resultatAvantImpot, tvaCollectee, tvaDeductible, impots, tvaAReverser,
      creditTvaFinDAnnee: creditFinal, masseSalariale: masse, controleMasseSalariale, resultatNet,
      totaux: {
        recettesHT: somme(recettesHT), depenses: somme(depenses), resultatAvantImpot: raiAnnuel,
        ibs: somme(ibs), resultatNet: r2(raiAnnuel - somme(ibs)),
        tvaNette: somme(nette), tvaAReverser: somme(tvaAReverser), masseSalariale: masse.total,
        enveloppeImpotsTaxes: r2(somme(tvaAReverser) + somme(impots.IBS.slice(0, 12).map((c) => c.retenu))),
      },
    };
  });
}

/** Le groupe : la somme des sociétés, colonne par colonne. */
export function totalGroupe(ps: readonly PrevisionSociete[]): { recettesHT: number[]; depenses: number[]; resultatAvantImpot: number[]; ibs: number[]; resultatNet: number[]; tvaAReverser: number[]; totaux: PrevisionSociete["totaux"] } {
  const add = (n: number, f: (p: PrevisionSociete) => readonly number[]) => zeros(n).map((_, i) => r2(ps.reduce((a, p) => a + (f(p)[i] ?? 0), 0)));
  const t = (k: keyof PrevisionSociete["totaux"]) => r2(ps.reduce((a, p) => a + p.totaux[k], 0));
  return {
    recettesHT: add(12, (p) => p.recettesHT), depenses: add(12, (p) => p.depenses),
    resultatAvantImpot: add(12, (p) => p.resultatAvantImpot), ibs: add(13, (p) => p.impots.IBS.map((c) => c.retenu)),
    resultatNet: add(13, (p) => p.resultatNet), tvaAReverser: add(12, (p) => p.tvaAReverser),
    totaux: {
      recettesHT: t("recettesHT"), depenses: t("depenses"), resultatAvantImpot: t("resultatAvantImpot"), ibs: t("ibs"),
      resultatNet: t("resultatNet"), tvaNette: t("tvaNette"), tvaAReverser: t("tvaAReverser"), masseSalariale: t("masseSalariale"),
      enveloppeImpotsTaxes: t("enveloppeImpotsTaxes"),
    },
  };
}
