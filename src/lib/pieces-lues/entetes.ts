/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REPÉRER L'EN-TÊTE ET LES TOTAUX D'UNE PIÈCE — par des règles, sans modèle (lot D2, P1-a, P4).
 *
 * Le n°, la date, le NIF, le RC, le NIS, l'article d'imposition, le total HT, la TVA PAR TAUX,
 * les taxes additionnelles, le timbre, le TTC et le « Net à payer » se lisent dans le texte par
 * des expressions régulières, et CHAQUE valeur garde son EXTRAIT — la ligne du papier où elle a
 * été lue : une proposition sans sa preuve ne se vérifie pas.
 *
 * ── POURQUOI UN SECOND CHEMIN, INDÉPENDANT DU MODÈLE ─────────────────────────────────────
 *
 * Le total qui sert au CONTRÔLE et au PRÉREMPLISSAGE vient d'ici. Celui que le modèle lit ne
 * sert qu'à recouper. Sans cela on comparerait le modèle à lui-même : une garde vraie qu'elle
 * soit armée ou non (§118.17).
 *
 * ── CE QUI N'EST JAMAIS DEVINÉ ───────────────────────────────────────────────────────────
 *
 * - « Total TVA » n'est pas le total : le TTC exige « TTC » (ou « toutes taxes comprises »), le
 *   HT exige « HT » ; un « Total » sans qualificatif n'est ni l'un ni l'autre.
 * - Un « Sous-total », un « Total HT brut », un total « à reporter » ne sont pas le total HT.
 * - Le même total imprimé avec DEUX valeurs différentes : aucune n'est retenue, le conflit est
 *   nommé (§118.34) — jamais « la première des deux ».
 * - Plusieurs montants après une étiquette : aucun n'est retenu. Un « 41 » d'« article 41 », un
 *   taux suivi de « % », une date, la « base » d'une TVA ne sont pas des montants.
 * - Un nombre ambigu (« 1.200 ») reste ILLISIBLE, avec son extrait (`montants.ts`).
 *
 * Une pièce porte deux identités (fournisseur et client) : les NIF, RC, NIS et AI sont rendus
 * en LISTES, sans deviner lequel est l'émetteur — `fournisseur.ts` les confronte à l'annuaire.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { formaterTaux } from "@/lib/artifact/factory/commercial";
import { normaliserNif, normaliserRc } from "@/lib/pieces-lues/fournisseur";
import { analyserNombre, analyserPourcentage, type NombreLu } from "@/lib/pieces-lues/montants";

export type TypePieceLue = "DEVIS" | "BON_DE_COMMANDE" | "FACTURE" | "AVOIR";

/** Une valeur repérée sur le papier, avec sa PREUVE. */
export interface Repere<T> {
  /** `null` = repérée mais illisible (voir `raison`). */
  valeur: T | null;
  raison: string | null;
  /** La ligne du papier où la valeur a été lue (bornée). */
  extrait: string;
  /** Rang de la ligne dans le texte, 1-indexé (§104.4). */
  ligne: number;
}

/** Le même champ imprimé avec plusieurs valeurs : aucune n'est retenue. */
export interface ConflitRepere {
  /** HT, TTC, NET, TIMBRE, TVA_TOTAL, TVA, TAXE ou DATE. */
  quoi: "HT" | "TTC" | "NET" | "TIMBRE" | "TVA_TOTAL" | "TVA" | "TAXE" | "DATE";
  /** Le nom du champ, tel qu'une personne le lit (« Total HT », « TVA 19 % »). */
  champ: string;
  /** Le taux, pour une TVA ou une taxe. */
  taux?: number | null;
  /** Les valeurs telles qu'imprimées. */
  valeurs: string[];
  extraits: string[];
}

/** Les totaux imprimés — ce que le contrôle compare au calcul des lignes. */
export interface TotauxReperes {
  totalHt: Repere<number> | null;
  /** La TVA imprimée PAR TAUX (fraction : 0,19), triée par taux. */
  tva: { taux: number; montant: Repere<number> }[];
  /** Une TVA imprimée sans taux (« Total TVA », « Montant TVA »). */
  totalTva: Repere<number> | null;
  /** Les taxes additionnelles (« Taxe Pub 2 % »), hors base de TVA. */
  taxes: { libelle: string; taux: number; montant: Repere<number> }[];
  timbre: Repere<number> | null;
  totalTtc: Repere<number> | null;
  netAPayer: Repere<number> | null;
  conflits: ConflitRepere[];
}

export interface EntetesReperes extends TotauxReperes {
  /** La nature de la pièce, lue à son numéro (ou à un titre seul sur sa ligne). */
  type: TypePieceLue | null;
  /** Le numéro de la PIÈCE : le premier « Facture N° … » du texte ; les autres sont dans `references`. */
  numero: Repere<string> | null;
  /** Tous les « Facture / Devis / BC N° … » lus — dont la pièce amont (« suivant BC N° … »). */
  references: { type: TypePieceLue; numero: string; extrait: string; ligne: number }[];
  /** La date d'émission, ISO `AAAA-MM-JJ`. */
  date: Repere<string> | null;
  /** Normalisés (chiffres du NIF, lettres et chiffres du RC). Fournisseur ET client : en listes. */
  nif: Repere<string>[];
  rc: Repere<string>[];
  nis: Repere<string>[];
  ai: Repere<string>[];
}

// ─────────────────────────────── Le pli, à longueur constante ───────────────────────────────

/**
 * Minuscules, sans accents, espaces insécables ramenées à l'espace — SANS changer la longueur :
 * chaque position du pli est celle de l'original, si bien qu'un extrait et un libellé se
 * découpent dans le texte imprimé, avec sa casse.
 */
function plier(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/[\u00a0\u202f\u2009\u2007\u2002\u2003\t]/.test(c)) { out += " "; continue; }
    if (c === "’" || c === "‘") { out += "'"; continue; }
    const d = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (d.length === 1) { out += d; continue; }
    const l = c.toLowerCase();
    out += l.length === 1 ? l : c;
  }
  return out;
}

const MAX_EXTRAIT = 160;
function extraitDe(ligne: string): string {
  const t = ligne.replace(/\s+/g, " ").trim();
  return t.length > MAX_EXTRAIT ? `${t.slice(0, MAX_EXTRAIT - 1)}…` : t;
}

// ─────────────────────────────── Les montants d'un segment ───────────────────────────────

const RE_DATE_SEGMENT = /(?<!\d)\d{1,2}\s?[/.-]\s?\d{1,2}\s?[/.-]\s?\d{2,4}(?!\d)/g;
/** « (base 794 500,00) », « sur 794 500 » : la base d'une TVA ou d'une taxe n'est pas son montant. */
const RE_BASE = /\(?\s*(?<![a-z])(?:base|sur)\s*:?\s*\d[\d .,]*\d\s*\)?/g;
const RE_MONTANT = /(?<![\d.,])(?:\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d{1,4})?|\d+(?:[.,]\d{1,4})?)(?!\d)/g;
/** Un nombre que précède « article », « n° », « page », « loi » est une référence, pas un montant. */
const RE_PREFIXE_REFERENCE = /(?<![a-z])(?:art(?:icle)?|n\s*[°º]|no|loi|page|p)\.?\s*$/;

/** Un montant de pièce porte des centimes, des milliers groupés ou au moins trois chiffres ; « 41 » non. */
function montantPlausible(jeton: string, minChiffres: number): boolean {
  return /[.,]\d{2}$/.test(jeton) || /\d[ .,]\d{3}/.test(jeton) || jeton.replace(/\D/g, "").length >= minChiffres;
}

function montantsDuSegment(segment: string): string[] {
  const propre = segment.replace(RE_DATE_SEGMENT, (m) => " ".repeat(m.length)).replace(RE_BASE, (m) => " ".repeat(m.length));
  const out: string[] = [];
  for (const m of propre.matchAll(RE_MONTANT)) {
    const i = m.index ?? 0;
    if (/^\s*%/.test(propre.slice(i + m[0].length))) continue;
    if (RE_PREFIXE_REFERENCE.test(propre.slice(0, i))) continue;
    if (!montantPlausible(m[0], 3)) continue;
    out.push(m[0]);
  }
  return out;
}

type Valeur = { lu: NombreLu; jeton: string };
const PLUSIEURS: NombreLu = { valeur: null, raison: "plusieurs montants suivent l'étiquette — aucun n'est retenu" };

function valeurDuSegment(segment: string): Valeur | null {
  const jetons = montantsDuSegment(segment);
  if (jetons.length === 0) return null;
  if (jetons.length > 1) return { lu: PLUSIEURS, jeton: jetons.join(" | ") };
  return { lu: analyserNombre(jetons[0]), jeton: jetons[0] };
}

/** Une ligne qui ne porte QU'UN montant (et un suffixe de devise) — la valeur d'une étiquette seule sur la sienne. */
function montantSeul(pli: string): Valeur | null {
  const t = pli.replace(/^\s*[:=]\s*/, "").trim().replace(/\s*(?:dzd|d\.\s?a\.?|da)\s*$/, "").trim();
  if (!/^\d[\d .,]*$/.test(t) || !montantPlausible(t, 4)) return null;
  const jetons = [...t.matchAll(RE_MONTANT)].map((m) => m[0]);
  if (jetons.length !== 1 || jetons[0] !== t) return null;
  return { lu: analyserNombre(t), jeton: t };
}

// ─────────────────────────────── Les étiquettes des totaux ───────────────────────────────

type ChampTotal = "HT" | "TTC" | "NET" | "TVA" | "TVA_TOTAL" | "TAXE" | "TIMBRE";

interface Etiquette {
  champ: ChampTotal;
  /** Plus petit = plus sûr : « Total HT net » (1) > « Total HT » (2) > « Montant HT » (3) ; 9 = jamais retenu. */
  classe: number;
  debut: number;
  fin: number;
  taux: number | null;
  libelle: string | null;
}

const TVA = String.raw`(?:t\.?\s?v\.?\s?a\.?|taxe\s+sur\s+la\s+valeur\s+ajoutee)(?![a-z])`;
const HT = String.raw`(?:h\.?\s?t\.?|hors\s+taxes?)(?![a-z])`;
const TTC = String.raw`(?:t\.?\s?t\.?\s?c\.?|toutes\s+taxes\s+comprises)(?![a-z])`;
const TAUX = String.raw`\(?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*\)?`;
/** Ni « sous-total », ni un mot qui finit par « total ». */
const DEBUT_TOTAL = String.raw`(?<![a-z-])(?<!sous\s)`;

/**
 * L'ORDRE EST UNE PRIORITÉ : une étiquette n'est retenue que si elle ne chevauche pas une
 * étiquette déjà retenue. « Montant TVA 19 % » est donc une TVA à 19 %, pas un « Montant TVA ».
 */
const ETIQUETTES: { champ: ChampTotal; re: RegExp; classe: (m: RegExpMatchArray) => number; taux?: number; libelle?: number }[] = [
  { champ: "NET", re: /(?<![a-z])(?:net|total|montant|somme)\s+a\s+payer(?![a-z])/g, classe: () => 1 },
  { champ: "TTC", re: new RegExp(String.raw`${DEBUT_TOTAL}(totale?s?|montants?|mt)(?:\s+general)?(?:\s+net)?\s*${TTC}`, "g"), classe: (m) => (m[1].startsWith("total") ? 1 : 2) },
  { champ: "TTC", re: new RegExp(String.raw`(?<![a-z])net\s+${TTC}`, "g"), classe: () => 2 },
  {
    champ: "HT",
    re: new RegExp(String.raw`${DEBUT_TOTAL}(totale?s?|montants?|mt)(\s+total)?(\s+net)?\s*${HT}(\s+net|\s+brut)?`, "g"),
    classe: (m) => (m[4]?.includes("brut") ? 9 : m[3] || m[4] ? 1 : m[1].startsWith("total") || m[2] ? 2 : 3),
  },
  { champ: "HT", re: new RegExp(String.raw`(?<![a-z])net\s+${HT}`, "g"), classe: () => 1 },
  { champ: "TVA", re: new RegExp(String.raw`(?<![a-z])${TVA}\s*:?\s*(?:a\s+|de\s+)?${TAUX}`, "g"), classe: () => 1, taux: 1 },
  { champ: "TAXE", re: new RegExp(String.raw`(?<![a-z])taxe\s+(?!sur\s+la\s+valeur)((?:[a-z][a-z.'-]*\s*){1,4}?)${TAUX}`, "g"), classe: () => 1, taux: 2, libelle: 1 },
  { champ: "TIMBRE", re: /(?<![a-z])(?:droit\s+de\s+)?timbre(?:\s+fiscal)?(?![a-z])/g, classe: () => 1 },
  { champ: "TVA_TOTAL", re: new RegExp(String.raw`(?<![a-z])(?:(?:total|montant|mt)\s+(?:de\s+la\s+|des\s+)?)?${TVA}`, "g"), classe: () => 1 },
];

/** Un total « à reporter » (bas de page) n'est pas le total de la pièce. */
const RE_REPORT = /(?<![a-z])(?:a\s+)?report(?:er|e|s)?(?![a-z])/;

function etiquettesDeLaLigne(pli: string, original: string): Etiquette[] {
  const gardees: Etiquette[] = [];
  for (const def of ETIQUETTES) {
    for (const m of pli.matchAll(def.re)) {
      const debut = m.index ?? 0;
      const fin = debut + m[0].length;
      if (gardees.some((g) => debut < g.fin && g.debut < fin)) continue;
      const taux = def.taux !== undefined ? analyserPourcentage(m[def.taux]).valeur : null;
      let libelle: string | null = null;
      if (def.libelle !== undefined) {
        const mots = m[def.libelle] ?? "";
        const off = debut + m[0].indexOf(mots, 4);
        libelle = original.slice(debut, off + mots.length).replace(/\s+/g, " ").trim();
      }
      gardees.push({ champ: def.champ, classe: def.classe(m), debut, fin, taux, libelle });
    }
  }
  return gardees.sort((a, b) => a.debut - b.debut);
}

interface Candidat { champ: ChampTotal; classe: number; taux: number | null; libelle: string | null; lu: NombreLu; jeton: string; extrait: string; ligne: number }

function prochaineLigne(plis: readonly string[], i: number): number | null {
  for (let j = i + 1; j < plis.length; j++) if (plis[j].trim()) return j;
  return null;
}

function candidatsTotaux(lignes: readonly string[], plis: readonly string[]): Candidat[] {
  const out: Candidat[] = [];
  for (let i = 0; i < lignes.length; i++) {
    const pli = plis[i];
    if (!pli.trim() || RE_REPORT.test(pli)) continue;
    const etiquettes = etiquettesDeLaLigne(pli, lignes[i]);
    for (let k = 0; k < etiquettes.length; k++) {
      const e = etiquettes[k];
      const fin = k + 1 < etiquettes.length ? etiquettes[k + 1].debut : pli.length;
      let v = valeurDuSegment(pli.slice(e.fin, fin));
      let extrait = extraitDe(lignes[i]);
      // L'ÉTIQUETTE SEULE SUR SA LIGNE (une mise en page en colonnes) : sa valeur est la ligne suivante, si
      // celle-ci ne porte qu'un montant. « Exonéré de TVA » n'est pas une étiquette seule : pas de saut.
      const seule = etiquettes.length === 1 && (pli.slice(0, e.debut) + pli.slice(e.fin)).replace(/[^a-z0-9]/g, "") === "";
      if (v === null && seule) {
        const j = prochaineLigne(plis, i);
        const lone = j === null ? null : montantSeul(plis[j]);
        if (j !== null && lone) {
          v = lone;
          extrait = extraitDe(`${lignes[i]} ${lignes[j]}`);
        }
      }
      if (v === null) continue;
      out.push({ champ: e.champ, classe: e.classe, taux: e.taux, libelle: e.libelle, lu: v.lu, jeton: v.jeton, extrait, ligne: i + 1 });
    }
  }
  return out;
}

/** Le champ, s'il ne porte qu'une valeur (illisible comprise) ; sinon `null` et le conflit nommé. */
function retenir(cands: readonly Candidat[], quoi: ConflitRepere["quoi"], champ: string, conflits: ConflitRepere[]): Repere<number> | null {
  if (cands.length === 0) return null;
  const meilleure = Math.min(...cands.map((c) => c.classe));
  const retenus = cands.filter((c) => c.classe === meilleure);
  const cle = (c: Candidat) => (c.lu.valeur !== null ? `v${Math.round(c.lu.valeur * 100)}` : `i${c.jeton}`);
  const distincts = new Map<string, Candidat>();
  for (const c of retenus) if (!distincts.has(cle(c))) distincts.set(cle(c), c);
  if (distincts.size === 1) {
    const c = retenus[0];
    return { valeur: c.lu.valeur, raison: c.lu.raison, extrait: c.extrait, ligne: c.ligne };
  }
  const vs = [...distincts.values()];
  conflits.push({ quoi, champ, taux: vs[0].taux, valeurs: vs.map((c) => c.jeton), extraits: vs.map((c) => c.extrait) });
  return null;
}

function grouper<K, T>(xs: readonly T[], cle: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(cle(x), [...(m.get(cle(x)) ?? []), x]);
  return m;
}

const cleTaux = (t: number): number => Math.round(t * 10_000);

function totauxReperes(lignes: readonly string[], plis: readonly string[]): TotauxReperes {
  const conflits: ConflitRepere[] = [];
  const cands = candidatsTotaux(lignes, plis);
  const de = (champ: ChampTotal) => cands.filter((c) => c.champ === champ);

  const tva: TotauxReperes["tva"] = [];
  for (const cs of grouper(de("TVA").filter((c) => c.taux !== null), (c) => cleTaux(c.taux as number)).values()) {
    const taux = cs[0].taux as number;
    const montant = retenir(cs, "TVA", `TVA ${formaterTaux(taux)}`, conflits);
    if (montant) tva.push({ taux, montant });
  }
  tva.sort((a, b) => a.taux - b.taux);

  // Une taxe se reconnaît à son TAUX : « Taxe Pub » et « TAXE PUB. » sont la même ligne lue deux fois, pas deux taxes.
  const taxes: TotauxReperes["taxes"] = [];
  for (const cs of grouper(de("TAXE").filter((c) => c.taux !== null && (c.taux as number) > 0), (c) => cleTaux(c.taux as number)).values()) {
    const montant = retenir(cs, "TAXE", cs[0].libelle ?? "Taxe", conflits);
    if (montant) taxes.push({ libelle: cs[0].libelle ?? "Taxe", taux: cs[0].taux as number, montant });
  }

  return {
    totalHt: retenir(de("HT").filter((c) => c.classe < 9), "HT", "Total HT", conflits),
    tva,
    totalTva: retenir(de("TVA_TOTAL"), "TVA_TOTAL", "Total TVA", conflits),
    taxes,
    timbre: retenir(de("TIMBRE"), "TIMBRE", "Droit de timbre", conflits),
    totalTtc: retenir(de("TTC"), "TTC", "Total TTC", conflits),
    netAPayer: retenir(de("NET"), "NET", "Net à payer", conflits),
    conflits,
  };
}

// ─────────────────────────────── Les dates ───────────────────────────────

const MOIS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const RE_DATE_NUM = /(?<!\d)(\d{1,2})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{4}|\d{2})(?!\d)/g;
const RE_DATE_TXT = new RegExp(String.raw`(?<!\d)(1er|\d{1,2})\s+(${MOIS.join("|")})\s+(\d{4})(?!\d)`, "g");

function iso(j: number, m: number, a: number): string | null {
  const annee = a < 100 ? 2000 + a : a;
  if (annee < 1990 || annee > 2100 || m < 1 || m > 12 || j < 1) return null;
  const jours = new Date(Date.UTC(annee, m, 0)).getUTCDate();
  if (j > jours) return null;
  return `${annee}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
}

/** Les dates d'une ligne pliée, avec leur position. Jour/mois/année : l'ordre français, jamais l'américain. */
function datesDe(pli: string): { iso: string; debut: number; fin: number }[] {
  const out: { iso: string; debut: number; fin: number }[] = [];
  for (const m of pli.matchAll(RE_DATE_NUM)) {
    const d = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) out.push({ iso: d, debut: m.index ?? 0, fin: (m.index ?? 0) + m[0].length });
  }
  for (const m of pli.matchAll(RE_DATE_TXT)) {
    const d = iso(m[1] === "1er" ? 1 : Number(m[1]), MOIS.indexOf(m[2]) + 1, Number(m[3]));
    if (d) out.push({ iso: d, debut: m.index ?? 0, fin: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * UNE DATE IMPRIMÉE, en ISO : « 05/09/2026 », « 5-9-26 », « 05 septembre 2026 », « 2026-09-05 ».
 * Le texte entier doit être une date (le modèle recopie la date seule) ; sinon `null`.
 */
export function dateLue(texte: unknown): string | null {
  if (typeof texte !== "string") return null;
  const t = plier(texte).trim();
  const isoDirect = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (isoDirect) return iso(Number(isoDirect[3]), Number(isoDirect[2]), Number(isoDirect[1]));
  const ds = datesDe(t);
  return ds.length === 1 && ds[0].debut === 0 && ds[0].fin === t.length ? ds[0].iso : null;
}

// ─────────────────────────────── Le numéro et la nature ───────────────────────────────

const RE_NUMERO = /(?<![a-z])(facture|devis|pro[\s-]?forma|bon\s+de\s+commande|b\.?\s?c\.?|avoir)(?![a-z])(?:\s+pro[\s-]?forma)?\s*(?:n\s*[°º]|n[o°º](?![a-z])|num(?:ero)?(?![a-z])|#)\.?\s*[:.-]?\s*/g;
const RE_TITRE = /^\s*(facture(?:\s+pro[\s-]?forma)?|devis|pro[\s-]?forma|bon\s+de\s+commande|avoir)\s*:?\s*$/;

function typeDe(mot: string): TypePieceLue {
  if (mot.startsWith("fact")) return "FACTURE";
  if (mot.startsWith("devis") || mot.startsWith("pro")) return "DEVIS";
  if (mot.startsWith("avoir")) return "AVOIR";
  return "BON_DE_COMMANDE";
}

/** Une forme courte (« BC », « RC », « AI ») ne compte qu'en majuscules : « j'ai » n'est pas un article d'imposition. */
const formeCourteEnMinuscules = (brut: string): boolean => {
  const lettres = brut.replace(/[^A-Za-z]/g, "");
  return lettres.length === 2 && lettres !== lettres.toUpperCase();
};

interface NumeroLu { type: TypePieceLue; numero: string; extrait: string; ligne: number; debut: number; fin: number }

function numerosDe(lignes: readonly string[], plis: readonly string[]): NumeroLu[] {
  const out: NumeroLu[] = [];
  for (let i = 0; i < lignes.length; i++) {
    for (const m of plis[i].matchAll(RE_NUMERO)) {
      const debut = m.index ?? 0;
      const motBrut = lignes[i].slice(debut, debut + m[1].length);
      if (m[1].replace(/[^a-z]/g, "") === "bc" && formeCourteEnMinuscules(motBrut)) continue;
      const apres = lignes[i].slice(debut + m[0].length);
      const v = /^([A-Za-z0-9][A-Za-z0-9/_.-]*[A-Za-z0-9]|[A-Za-z0-9])/.exec(apres);
      if (!v || !/\d/.test(v[1])) continue;
      out.push({ type: typeDe(m[1]), numero: v[1], extrait: extraitDe(lignes[i]), ligne: i + 1, debut, fin: debut + m[0].length + v[1].length });
    }
  }
  return out;
}

// ─────────────────────────────── Les identifiants ───────────────────────────────

type ChampId = "NIF" | "NIS" | "RC" | "AI";
const IDENTIFIANTS: { champ: ChampId; re: RegExp; court: boolean }[] = [
  { champ: "NIF", re: /(?<![a-z])(?:n\.?\s?i\.?\s?f\.?|(?:numero\s+d'\s?)?identifi\w*\s+fiscal\w*)(?![a-z])/g, court: false },
  { champ: "NIS", re: /(?<![a-z])(?:n\.?\s?i\.?\s?s\.?|(?:numero\s+d'\s?)?identifi\w*\s+statisti\w*)(?![a-z])/g, court: false },
  { champ: "RC", re: /(?<![a-z])(?:r\.?\s?c\.?|registre\s+(?:du\s+|de\s+)?commerce)(?![a-z])/g, court: true },
  { champ: "AI", re: /(?<![a-z])(?:a\.?\s?i\.?|art(?:icle)?\.?\s*(?:d'\s?)?imp(?:osition)?\.?)(?![a-z])/g, court: true },
];

function valeurIdentifiant(champ: ChampId, segment: string): { valeur: string | null; raison: string | null } | null {
  const s = segment.replace(/^\s*(?:n\s*[°º]|n[o°º](?![A-Za-z])|num(?:ero)?(?![A-Za-z]))?\.?\s*[:.=-]?\s*/i, "");
  const jetons = s.split(/\s+/).filter(Boolean);
  const pris: string[] = [];
  for (const brutJeton of jetons) {
    // UNE PONCTUATION FERME L'IDENTIFIANT, elle ne le cache pas : « NIF 001616098765432, RC … » — la forme d'un contrat
    // qui cite ses parties en ligne — portait un NIF que la virgule rendait illisible.
    const j = brutJeton.replace(/[,;]+$/, "");
    const chiffre = /\d/.test(j);
    if (j && (champ === "RC" ? chiffre || (/^[A-Za-z]$/.test(j) && pris.length > 0) : /^[\d.]+$/.test(j))) pris.push(j);
    else break;
    if (j !== brutJeton) break;
  }
  const brut = pris.join(" ");
  if (!brut) return null;
  if (champ === "RC") {
    const v = normaliserRc(brut);
    return { valeur: v, raison: v ? null : `RC « ${brut} » : forme non reconnue` };
  }
  const chiffres = brut.replace(/\D/g, "");
  if (champ === "AI") {
    const ok = chiffres.length >= 8 && chiffres.length <= 15;
    return { valeur: ok ? chiffres : null, raison: ok ? null : `article d'imposition « ${brut} » : 8 à 15 chiffres attendus` };
  }
  const v = normaliserNif(brut);
  return { valeur: v, raison: v ? null : `${champ} « ${brut} » : 15 à 20 chiffres attendus` };
}

function identifiantsDe(lignes: readonly string[], plis: readonly string[]): Record<ChampId, Repere<string>[]> {
  const out: Record<ChampId, Repere<string>[]> = { NIF: [], NIS: [], RC: [], AI: [] };
  for (let i = 0; i < lignes.length; i++) {
    const marques: { champ: ChampId; debut: number; fin: number }[] = [];
    for (const def of IDENTIFIANTS) {
      for (const m of plis[i].matchAll(def.re)) {
        const debut = m.index ?? 0;
        const fin = debut + m[0].length;
        if (def.court && formeCourteEnMinuscules(lignes[i].slice(debut, fin))) continue;
        if (marques.some((x) => debut < x.fin && x.debut < fin)) continue;
        marques.push({ champ: def.champ, debut, fin });
      }
    }
    marques.sort((a, b) => a.debut - b.debut);
    marques.forEach((mq, k) => {
      const fin = k + 1 < marques.length ? marques[k + 1].debut : lignes[i].length;
      const v = valeurIdentifiant(mq.champ, lignes[i].slice(mq.fin, fin).replace(/[\u00a0\u202f\u2009]/g, " "));
      if (!v) return;
      const deja = out[mq.champ].some((x) => (v.valeur !== null ? x.valeur === v.valeur : x.raison === v.raison));
      if (!deja) out[mq.champ].push({ valeur: v.valeur, raison: v.raison, extrait: extraitDe(lignes[i]), ligne: i + 1 });
    });
  }
  return out;
}

// ─────────────────────────────── Le repérage ───────────────────────────────

/** Les mots d'une ligne qui disent qu'une date N'EST PAS celle de la pièce — dont la pièce amont (« suivant devis … du »). */
const RE_DATE_AUTRE = /(?<![a-z])(?:echeance|livraison|validite|expir\w*|limite|naissance|reglement|paiement|valable|suivant|selon|conformement|ref(?:erence)?)(?![a-z])/;

export function repererEntetes(texte: string): EntetesReperes {
  const lignes = String(texte ?? "").replace(/\r\n?/g, "\n").split("\n");
  const plis = lignes.map(plier);

  const numeros = numerosDe(lignes, plis);
  const premier = numeros[0] ?? null;
  const references: EntetesReperes["references"] = [];
  for (const n of numeros) {
    if (!references.some((r) => r.type === n.type && r.numero === n.numero)) references.push({ type: n.type, numero: n.numero, extrait: n.extrait, ligne: n.ligne });
  }
  let type: TypePieceLue | null = premier?.type ?? null;
  if (!type) {
    const titre = plis.map((p) => RE_TITRE.exec(p)).find(Boolean);
    if (titre) type = typeDe(titre[1]);
  }

  // LA DATE DE LA PIÈCE : une date sur une ligne « Date … », après « le » / « du », ou sur la ligne du numéro —
  // jamais une échéance, une livraison ni une validité ; deux dates différentes → conflit, aucune retenue.
  const conflitsEntete: ConflitRepere[] = [];
  const datesVues = new Map<string, { extrait: string; ligne: number }>();
  for (let i = 0; i < lignes.length; i++) {
    const pli = plis[i];
    if (RE_DATE_AUTRE.test(pli)) continue;
    const surNumero = numeros.filter((n) => n.ligne === i + 1);
    // Une ligne qui porte le numéro d'une AUTRE pièce (la référence amont) date cette autre pièce.
    if (surNumero.some((n) => n !== premier)) continue;
    for (const d of datesDe(pli)) {
      if (surNumero.some((n) => d.debut < n.fin && n.debut < d.fin)) continue;
      const avant = pli.slice(Math.max(0, d.debut - 6), d.debut);
      const contexte = /(?<![a-z])date(?![a-z])/.test(pli) || /(?<![a-z])(?:le|du)\s*$/.test(avant) || surNumero.length > 0;
      if (contexte && !datesVues.has(d.iso)) datesVues.set(d.iso, { extrait: extraitDe(lignes[i]), ligne: i + 1 });
    }
  }
  let date: Repere<string> | null = null;
  if (datesVues.size === 1) {
    const [[d, preuve]] = [...datesVues.entries()];
    date = { valeur: d, raison: null, ...preuve };
  } else if (datesVues.size > 1) {
    conflitsEntete.push({ quoi: "DATE", champ: "Date", valeurs: [...datesVues.keys()], extraits: [...datesVues.values()].map((x) => x.extrait) });
  }

  const ids = identifiantsDe(lignes, plis);
  const totaux = totauxReperes(lignes, plis);
  return {
    ...totaux,
    conflits: [...conflitsEntete, ...totaux.conflits],
    type,
    numero: premier ? { valeur: premier.numero, raison: null, extrait: premier.extrait, ligne: premier.ligne } : null,
    references,
    date,
    nif: ids.NIF,
    rc: ids.RC,
    nis: ids.NIS,
    ai: ids.AI,
  };
}
