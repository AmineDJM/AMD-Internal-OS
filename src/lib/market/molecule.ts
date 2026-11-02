/**
 * INTELLIGENCE PAR MOLÉCULE — « qui est sur ce marché, et combien pèse-t-il ? »
 *
 * Une molécule, au sens métier, n'est pas seulement un principe actif : c'est un **triplet
 * molécule + dosage + forme**. AMOXICILLINE 500 mg gélule et AMOXICILLINE 1 g injectable ne
 * s'affrontent pas sur le même marché, ne se prescrivent pas dans les mêmes services et ne
 * s'achètent pas par les mêmes canaux. C'est ce triplet qui est interrogeable ici.
 *
 * Trois sources RÉELLES, qui ne se nomment pas pareil, sont réconciliées :
 *   • IQVIA (ville)   — `mol` en anglais (« AMOXICILLIN »), dosage et forme noyés dans la
 *     présentation abrégée (« CP.PE 875MG/ 125 MG 10 ») ;
 *   • PCH (hôpital)   — libellé français avec le dosage dans le texte (« AMOXICILLINE INJ 1G »)
 *     et une forme en clair ;
 *   • Nomenclature DZ — la seule structurée (DCI, forme, dosage) et la seule qui dise si le
 *     produit est **fabriqué localement ou importé**.
 *
 * D'où les trois normalisations de ce fichier : le **radical** de molécule (qui rapproche
 * « AMOXICILLIN » et « AMOXICILLINE TRIHYDRATÉE »), le **dosage** et la **forme galénique**
 * canonique. Sans elles, les trois marchés resteraient trois silos.
 *
 * Aucune donnée simulée : tout provient des jeux IQVIA / PCH / Nomenclature déjà embarqués.
 *
 * ⚠️ Ce module lit les données (donc `fs`) : il est **serveur uniquement**. Les normalisations
 * pures — radical de molécule, dosage, forme galénique — vivent dans `./galenic`, importable
 * par les composants client. On les réexporte ici pour que le serveur n'ait qu'un point d'entrée.
 */
import { getMarketData, DZD_PER_USD, type IqviaRow, type PchRow, type NomRow } from "./data";
import { normText } from "./text";
import { moleculeStem, moleculeMatches, canonicalForm, extractDosage, dosageMatches, GALENIC_FORMS, type GalenicForm } from "./galenic";

export {
  moleculeStem, moleculeMatches, canonicalForm, extractDosage, dosageMatches,
  GALENIC_FORMS, type GalenicForm,
};

// ───────────────────────────── Analyse concurrentielle ─────────────────────────────

export interface MoleculeSearchInput {
  /** Principe actif (obligatoire pour l'analyse). */
  molecule: string;
  /** Dosage — « 500 mg », « 1g/200mg »… Facultatif : absent = tous dosages confondus. */
  dosage?: string | null;
  /** Forme galénique canonique. Facultatif : absent = toutes formes. */
  form?: GalenicForm | null;
}

/** Un acteur du marché de cette molécule. */
export interface MoleculeCompetitor {
  lab: string;
  valueDzd: number;
  volume: number;
  /** Part de marché en VALEUR, tous segments confondus (%). */
  share: number;
  villeDzd: number;
  hopitalDzd: number;
  /** Marques commercialisées (les plus fortes d'abord). */
  brands: string[];
  /** Fabriqué localement, importé, ou les deux — d'après la nomenclature. */
  origin: "LOCAL" | "IMPORT" | "MIXTE" | null;
  /** Nombre d'enregistrements à la nomenclature pour cette molécule. */
  registrations: number;
}

export interface MoleculeSegment {
  valueDzd: number;
  volume: number;
  /** Part de ce segment dans le marché total de la molécule (%). */
  pct: number;
  /** Nombre d'acteurs présents sur ce segment. */
  players: number;
}

export interface MoleculeAnalysis {
  molecule: string;
  dosage: string | null;
  form: GalenicForm | null;
  /** Dosages et formes réellement rencontrés (aide à affiner la recherche). */
  dosagesFound: { value: string; valueDzd: number }[];
  formsFound: { value: GalenicForm; valueDzd: number }[];
  total: { valueDzd: number; valueUsd: number; volume: number; players: number };
  ville: MoleculeSegment;
  hopital: MoleculeSegment;
  competitors: MoleculeCompetitor[];
  /** Part cumulée des 3 premiers acteurs (%) — mesure de concentration. */
  top3Share: number;
  /** Indice de Herfindahl (0-10000) : > 2500 = marché concentré. */
  hhi: number;
  /** Enregistrements à la nomenclature (qui a le droit de vendre, local ou importé). */
  registered: { lab: string; brand: string; form: string; dosage: string; origin: string; status: string }[];
  /** Ce qui a réellement été apparié, pour que le chiffre soit vérifiable. */
  matched: { ville: number; hopital: number; nomenclature: number };
}

const clean = (s: string | null | undefined) => (s ?? "").trim();

/**
 * Les trois sources n'écrivent pas les laboratoires pareil : « SAIDAL » (IQVIA),
 * « GROUPE SAIDAL » (nomenclature), « EPE / SPA GROUPE SAIDAL » (PCH). Sans réconciliation,
 * le même acteur apparaîtrait trois fois et l'origine (local / importé) ne se rattacherait
 * à rien. On réduit chaque raison sociale à son **noyau** : on retire les formes juridiques
 * et les mots génériques, et on garde le mot distinctif le plus long.
 */
const LEGAL_WORDS = new Set([
  "EPE", "SPA", "SARL", "EURL", "SNC", "SPAS", "GROUPE", "GROUP", "LABORATOIRE", "LABORATOIRES",
  "LAB", "LABS", "PHARMA", "PHARMACEUTIQUE", "PHARMACEUTICAL", "PHARMACEUTICALS", "INDUSTRIE",
  "INDUSTRIES", "INDUSTRY", "SA", "LTD", "LLC", "GMBH", "INC", "CO", "AND", "DU", "DE", "DES",
  "ALGERIE", "ALGERIA", "FZ", "FZE", "INTERNATIONAL", "PRODUCTION", "MEDICAMENT", "MEDICAMENTS",
]);

export function labKey(raw: string | null | undefined): string {
  const words = normText(raw).split(" ").filter((w) => w.length > 1 && !LEGAL_WORDS.has(w));
  if (words.length === 0) return normText(raw);
  // Le mot distinctif = le plus long ; à longueur égale, le premier (« HIKMA », « SAIDAL »).
  return words.reduce((best, w) => (w.length > best.length ? w : best), words[0]);
}

interface Agg { label: string; valueDzd: number; volume: number; villeDzd: number; hopitalDzd: number; brands: Map<string, number> }
const emptyAgg = (label: string): Agg => ({ label, valueDzd: 0, volume: 0, villeDzd: 0, hopitalDzd: 0, brands: new Map() });

function keep(input: MoleculeSearchInput, molecule: string | null, formSource: string | null, dosageSource: string | null): boolean {
  if (!moleculeMatches(molecule, input.molecule)) return false;
  if (input.form && canonicalForm(formSource) !== input.form) return false;
  if (input.dosage && !dosageMatches(extractDosage(dosageSource), input.dosage)) return false;
  return true;
}

/**
 * Analyse complète d'une molécule : poids du marché, partage ville / hôpital, part de marché
 * de chaque laboratoire, concentration, et qui est enregistré (local ou importé).
 * Renvoie null si la molécule demandée est introuvable dans les trois sources.
 */
export function analyzeMolecule(input: MoleculeSearchInput): MoleculeAnalysis | null {
  const q = clean(input.molecule);
  if (q.length < 3) return null;
  const { iqviaProducts, pch, nom } = getMarketData();

  const byLab = new Map<string, Agg>();
  const dosages = new Map<string, number>();
  const forms = new Map<GalenicForm, number>();
  let villeValue = 0, villeVolume = 0, hopitalValue = 0, hopitalVolume = 0;
  const villeLabs = new Set<string>(), hopitalLabs = new Set<string>();
  let nVille = 0, nHopital = 0;

  const bump = (lab: string, brand: string, value: number, volume: number, segment: "VILLE" | "HOPITAL") => {
    const k = labKey(lab);
    const a = byLab.get(k) ?? emptyAgg(lab);
    // On garde le libellé le plus court comme nom d'affichage (« SAIDAL » plutôt que
    // « EPE / SPA GROUPE SAIDAL ») : c'est celui que le métier emploie.
    if (lab.length < a.label.length) a.label = lab;
    a.valueDzd += value;
    a.volume += volume;
    if (segment === "VILLE") a.villeDzd += value; else a.hopitalDzd += value;
    if (brand) a.brands.set(brand, (a.brands.get(brand) ?? 0) + value);
    byLab.set(k, a);
  };

  // ── Marché de ville (IQVIA)
  for (const r of iqviaProducts as IqviaRow[]) {
    if (!keep(input, r.mol, r.pres, r.pres)) continue;
    const value = r.valDzd ?? 0;
    const volume = r.vol ?? 0;
    const lab = clean(r.lab) || "—";
    nVille++;
    villeValue += value; villeVolume += volume; villeLabs.add(labKey(lab));
    bump(lab, clean(r.brand), value, volume, "VILLE");
    const d = extractDosage(r.pres);
    if (d) dosages.set(d, (dosages.get(d) ?? 0) + value);
    const f = canonicalForm(r.pres);
    forms.set(f, (forms.get(f) ?? 0) + value);
  }

  // ── Marché hospitalier (réceptions PCH)
  for (const r of pch as PchRow[]) {
    const label = clean(r.text) || clean(r.full);
    if (!keep(input, label, r.forme ?? label, label)) continue;
    const value = r.valDzd ?? 0;
    const volume = r.vol ?? r.qte ?? 0;
    const lab = clean(r.lab) || "—";
    nHopital++;
    hopitalValue += value; hopitalVolume += volume; hopitalLabs.add(labKey(lab));
    bump(lab, "", value, volume, "HOPITAL");
    const d = extractDosage(label);
    if (d) dosages.set(d, (dosages.get(d) ?? 0) + value);
    const f = canonicalForm(r.forme ?? label);
    forms.set(f, (forms.get(f) ?? 0) + value);
  }

  // ── Nomenclature : qui a le droit de vendre, et depuis où (local / importé)
  const registered: MoleculeAnalysis["registered"] = [];
  const originByLab = new Map<string, Set<string>>();
  const regCountByLab = new Map<string, number>();
  for (const r of nom as NomRow[]) {
    if (!moleculeMatches(r.dciNorm ?? r.dci, q)) continue;
    if (input.form && canonicalForm(r.formeNorm ?? r.forme) !== input.form) continue;
    if (input.dosage && !dosageMatches(extractDosage(r.dosageNorm ?? r.dosage), input.dosage)) continue;
    const lab = clean(r.lab) || "—";
    const origin = clean(r.origin).toUpperCase();
    registered.push({
      lab, brand: clean(r.brand) || "—", form: clean(r.forme) || "—",
      dosage: clean(r.dosage) || "—", origin: origin || "—", status: clean(r.status) || "—",
    });
    const lk = labKey(lab);
    if (origin) (originByLab.get(lk) ?? originByLab.set(lk, new Set()).get(lk)!).add(origin);
    regCountByLab.set(lk, (regCountByLab.get(lk) ?? 0) + 1);
  }

  const totalValue = villeValue + hopitalValue;
  if (totalValue === 0 && registered.length === 0) return null;

  const originOf = (lab: string): MoleculeCompetitor["origin"] => {
    const set = originByLab.get(lab);
    if (!set || set.size === 0) return null;
    const local = set.has("LOCAL");
    const imported = [...set].some((o) => o !== "LOCAL");
    if (local && imported) return "MIXTE";
    return local ? "LOCAL" : "IMPORT";
  };

  const competitors: MoleculeCompetitor[] = [...byLab.entries()]
    .map(([key, a]) => ({
      lab: a.label,
      valueDzd: a.valueDzd,
      volume: a.volume,
      share: totalValue > 0 ? (a.valueDzd / totalValue) * 100 : 0,
      villeDzd: a.villeDzd,
      hopitalDzd: a.hopitalDzd,
      brands: [...a.brands.entries()].sort((x, y) => y[1] - x[1]).map(([b]) => b).slice(0, 6),
      origin: originOf(key),
      registrations: regCountByLab.get(key) ?? 0,
    }))
    .sort((a, b) => b.valueDzd - a.valueDzd);

  const top3Share = competitors.slice(0, 3).reduce((s, c) => s + c.share, 0);
  const hhi = Math.round(competitors.reduce((s, c) => s + c.share * c.share, 0));

  return {
    molecule: q.toUpperCase(),
    dosage: input.dosage ? extractDosage(input.dosage) : null,
    form: input.form ?? null,
    dosagesFound: [...dosages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([value, valueDzd]) => ({ value, valueDzd })),
    formsFound: [...forms.entries()].sort((a, b) => b[1] - a[1]).map(([value, valueDzd]) => ({ value, valueDzd })),
    total: {
      valueDzd: totalValue,
      valueUsd: totalValue / DZD_PER_USD,
      volume: villeVolume + hopitalVolume,
      players: byLab.size,
    },
    ville: { valueDzd: villeValue, volume: villeVolume, pct: totalValue > 0 ? (villeValue / totalValue) * 100 : 0, players: villeLabs.size },
    hopital: { valueDzd: hopitalValue, volume: hopitalVolume, pct: totalValue > 0 ? (hopitalValue / totalValue) * 100 : 0, players: hopitalLabs.size },
    competitors,
    top3Share,
    hhi,
    registered: registered.sort((a, b) => a.lab.localeCompare(b.lab)).slice(0, 80),
    matched: { ville: nVille, hopital: nHopital, nomenclature: registered.length },
  };
}

// ───────────────────────────── Suggestions (saisie assistée) ─────────────────────────────

let moleculeIndex: { label: string; stem: string; valueDzd: number }[] | null = null;

/** Index des molécules connues, pondérées par le poids de marché (les grosses d'abord). */
function getMoleculeIndex() {
  if (moleculeIndex) return moleculeIndex;
  const { iqviaProducts, nom } = getMarketData();
  const byStem = new Map<string, { label: string; valueDzd: number }>();
  for (const r of iqviaProducts) {
    const label = clean(r.mol);
    if (!label) continue;
    const stem = moleculeStem(label);
    if (!stem) continue;
    const cur = byStem.get(stem);
    if (cur) cur.valueDzd += r.valDzd ?? 0;
    else byStem.set(stem, { label, valueDzd: r.valDzd ?? 0 });
  }
  // La nomenclature apporte les molécules enregistrées mais absentes du marché de ville.
  for (const r of nom) {
    const label = clean(r.dciNorm ?? r.dci);
    if (!label) continue;
    const stem = moleculeStem(label);
    if (!stem || byStem.has(stem)) continue;
    byStem.set(stem, { label, valueDzd: 0 });
  }
  moleculeIndex = [...byStem.entries()]
    .map(([stem, v]) => ({ stem, label: v.label, valueDzd: v.valueDzd }))
    .sort((a, b) => b.valueDzd - a.valueDzd);
  return moleculeIndex;
}

/** Molécules proposées pendant la frappe (préfixe du radical, les plus grosses d'abord). */
export function moleculeSuggestions(q: string, limit = 12): { label: string; valueDzd: number }[] {
  const stem = moleculeStem(q);
  if (stem.length < 2) return [];
  const first = stem.split(" ")[0];
  return getMoleculeIndex()
    .filter((m) => m.stem.split(" ").some((s) => s.startsWith(first)))
    .slice(0, limit)
    .map(({ label, valueDzd }) => ({ label, valueDzd }));
}

/** Laboratoires proposés pendant la frappe. */
export function labSuggestions(q: string, limit = 12): string[] {
  const needle = normText(q);
  if (needle.length < 2) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of getMarketData().labs.sort((a, b) => (b.valDzd ?? 0) - (a.valDzd ?? 0))) {
    const lab = clean(r.lab);
    if (!lab || seen.has(lab)) continue;
    if (!normText(lab).includes(needle)) continue;
    seen.add(lab);
    out.push(lab);
    if (out.length >= limit) break;
  }
  return out;
}
