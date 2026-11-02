/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RAPPROCHER DEUX NOMS ÉCRITS PAR DES HUMAINS — primitives pures, sans état, sans base.
 *
 * ── LE PROBLÈME RÉEL ─────────────────────────────────────────────────────────────────────
 *
 * « SD », « SD Pharma », « S.D. Pharmaceuticals » désignent la même société ; « SAI » désigne la
 * « Société Algérienne d'Infectiologie » ; et quelqu'un qui tape vite écrit « Kwlaity ». La
 * résolution est un CLASSEMENT DE CANDIDATS avec un score et une raison — jamais une fusion
 * silencieuse : deux sociétés réellement différentes restent différentes, et c'est la POLITIQUE
 * d'appel (`decisive` / `ambiguous`) qui décide d'auto-choisir ou de présenter les candidats.
 *
 * ── POURQUOI CE FICHIER EST ICI ET PAS DANS `assistant/` ─────────────────────────────────
 *
 * Ces primitives vivaient dans `src/platform/ia/lectures/entity-normalize.ts`. Elles n'ont pourtant rien
 * d'Adam : ce sont des mathématiques de chaînes. La couche de connaissance de l'ERP en a besoin,
 * et un module de l'ERP qui importerait « du Adam » serait le couplage inverse — le plus
 * difficile à voir et le premier à casser le jour où Adam est extrait. Le fichier d'origine
 * subsiste et RÉEXPORTE d'ici : aucun appelant n'a changé.
 *
 * ── CE QU'IL NE CONTIENT PAS, DÉLIBÉRÉMENT ───────────────────────────────────────────────
 *
 * Aucun nom d'entreprise, d'organisation, de produit ou de molécule. Uniquement des primitives
 * GÉNÉRALES applicables à des noms jamais vus. Un dictionnaire codé en dur serait faux le
 * lendemain de son écriture, et l'ERP connaît déjà ses propres entités : c'est de SES données que
 * doivent sortir les alias, pas d'une liste inventée ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Minuscules sans accents ; ponctuation d'entreprise (« . », « & », « - », « / ») → espaces. */
export function foldOrg(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.&\-_/,'’()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mots-outils du français courant — ignorés pour les INITIALES et le recouvrement. */
const STOPWORDS = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "et", "en", "au", "aux", "pour", "a", "the", "of"]);

/** Bruit « corporate » — utile au repli quand deux noms ne diffèrent que par lui. */
const CORP_NOISE = new Set([
  "pharma", "pharmaceutical", "pharmaceuticals", "pharmaceutique", "laboratoire", "laboratoires",
  "labs", "lab", "sarl", "spa", "eurl", "sas", "ltd", "llc", "inc", "gmbh", "co", "company", "group", "groupe",
]);

/**
 * Jetons significatifs d'un nom, dans l'ordre. Les suites de jetons d'UNE lettre sont
 * recollées AVANT le filtre des mots-outils (« s d pharmaceuticals » → « sd … » : c'est ce
 * que produit « S.D. » après repli — et « d » recollé n'est plus le « d' » du français,
 * qu'un filtre prématuré aurait avalé). Un « d » ISOLÉ (« société algérienne d infectiologie »)
 * reste seul après recollage et tombe, lui, au filtre des mots-outils.
 */
export function orgTokens(s: string): string[] {
  const raw = foldOrg(s).split(" ").filter(Boolean);
  const merged: string[] = [];
  let run = "";
  for (const t of raw) {
    if (t.length === 1) { run += t; continue; }
    if (run) { merged.push(run); run = ""; }
    merged.push(t);
  }
  if (run) merged.push(run);
  return merged.filter((t) => !STOPWORDS.has(t));
}

/** Jetons SANS le bruit corporate — la partie identitaire du nom. */
export function coreTokens(s: string): string[] {
  const t = orgTokens(s).filter((x) => !CORP_NOISE.has(x));
  return t.length ? t : orgTokens(s); // un nom fait UNIQUEMENT de bruit garde ses jetons
}

/** Initiales des jetons significatifs — « société algérienne d'infectiologie » → « sai ». */
export function initialsOf(s: string): string {
  return orgTokens(s).map((t) => t[0]).join("");
}

/** Recouvrement de Jaccard entre deux ensembles de jetons (0..1). */
export function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

// ────────────────────────────────── Les fautes de frappe ──────────────────────────────────

/**
 * DISTANCE D'ÉDITION AVEC TRANSPOSITION (Damerau-Levenshtein), BORNÉE.
 *
 * La transposition compte pour UNE opération, et ce n'est pas un raffinement gratuit : « Kwaltiy »
 * pour « Kwality » est l'erreur de frappe la plus courante au clavier, et sans elle cette faute
 * coûte 2 — soit le même prix qu'un mot réellement différent.
 *
 * La borne n'est pas une optimisation : elle est la SÉMANTIQUE. On ne cherche pas « à quelle
 * distance sont ces deux mots », on demande « sont-ils à moins de `max` l'un de l'autre ». Dès
 * qu'une ligne entière dépasse la borne, la réponse est non et on s'arrête — ce qui évite aussi de
 * calculer une matrice complète pour deux chaînes sans rapport.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Transposition : « ab » ↔ « ba » coûte 1, pas 2.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    // Toute la ligne dépasse déjà la borne : aucune suite ne pourra redescendre.
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array(b.length + 1);
  }
  return prev[b.length];
}

/**
 * COMBIEN DE FAUTES ON TOLÈRE, selon la longueur.
 *
 * Une faute sur trois lettres n'est pas une faute : c'est un autre mot. « SAI » et « SAT » sont à
 * distance 1 et n'ont rien à voir ; « pembrolizumab » et « pembrolizumb » sont à distance 1 et
 * sont le même produit. La tolérance suit donc la longueur, et vaut ZÉRO sur les chaînes courtes —
 * là où une lettre porte le sens, on exige l'exactitude.
 */
export function typoBudget(len: number): number {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  if (len <= 12) return 2;
  return 3;
}

/**
 * Deux noms sont-ils la même chose mal tapée ? Rend la similarité (0..1) ou 0 si la faute dépasse
 * le budget. On compare les JETONS DE CŒUR recollés : « Kwlaity Pharma » et « Kwality » doivent se
 * rapprocher, et le générique « Pharma » ne doit ni aider ni nuire.
 */
export function typoSimilarity(a: string, b: string): number {
  const ca = coreTokens(a).join("");
  const cb = coreTokens(b).join("");
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  const budget = typoBudget(Math.min(ca.length, cb.length));
  if (budget === 0) return 0;
  const d = editDistance(ca, cb, budget);
  if (d > budget) return 0;
  return 1 - d / Math.max(ca.length, cb.length);
}

// ────────────────────────────────── Le classement ──────────────────────────────────

export interface OrgMatch {
  /** La valeur candidate TELLE QU'ELLE EXISTE dans les données (jamais réécrite). */
  value: string;
  /** 0..1 — comparable d'une requête à l'autre. */
  score: number;
  /** La raison LISIBLE du rapprochement — la confiance s'explique, elle ne s'affirme pas. */
  why: string;
}

/**
 * Classe des candidats face à une requête. Règles, de la plus forte à la plus faible :
 *   • repli exact (« kwality pharma » = « Kwality Pharma ») ;
 *   • identité de cœur (« sd » = « SD Pharmaceuticals » sans le bruit corporate) ;
 *   • ACRONYME : la requête est les initiales du candidat (« sai » ← « Société Algérienne
 *     d'Infectiologie ») — ou l'inverse ;
 *   • la requête est CONTENUE dans le candidat (jetons de la requête tous présents) ;
 *   • FAUTE DE FRAPPE sur le nom entier (budget selon la longueur) ;
 *   • recouvrement partiel de jetons (score proportionnel).
 *
 * La faute de frappe est délibérément placée AU-DESSUS du recouvrement partiel : « Kwlaity Pharma »
 * pour « Kwality Pharma » est un rapprochement plus sûr que « Pharma X » pour « Pharma Y », qui ne
 * partage qu'un mot générique. Elle ne s'applique jamais quand un barreau supérieur a déjà conclu.
 */
export function rankOrgCandidates(query: string, candidates: string[]): OrgMatch[] {
  const q = foldOrg(query);
  if (!q) return [];
  const qTokens = orgTokens(query);
  const qCore = coreTokens(query);
  const qJoined = qTokens.join("");

  const out: OrgMatch[] = [];
  for (const value of candidates) {
    const v = foldOrg(value);
    if (!v) continue;
    const vTokens = orgTokens(value);
    const vCore = coreTokens(value);

    let score = 0;
    let why = "";
    if (v === q) { score = 1; why = "nom identique (accents/ponctuation près)"; }
    else if (qCore.length && vCore.length && qCore.join(" ") === vCore.join(" ")) {
      score = 0.95; why = "même nom sans le générique (Pharma, Laboratoires…)";
    } else if (qJoined.length >= 2 && initialsOf(value) === qJoined) {
      score = 0.88; why = `acronyme des initiales de « ${value} »`;
    } else if (vTokens.join("").length >= 2 && initialsOf(query) === vTokens.join("")) {
      score = 0.85; why = "le candidat est l'acronyme de la requête";
    } else if (qTokens.length && qTokens.every((t) => vTokens.includes(t))) {
      score = 0.8; why = "tous les mots de la requête sont dans le nom";
    } else {
      const typo = typoSimilarity(query, value);
      const overlap = tokenOverlap(qCore, vCore);
      const fromOverlap = overlap > 0 ? 0.3 + overlap * 0.4 : 0;
      // Le seuil de 0.8 sur la similarité évite de baptiser « faute de frappe » deux mots
      // simplement voisins : sous ce niveau, le budget a beau être tenu, le mot a changé de sens.
      const fromTypo = typo >= 0.8 ? 0.68 + typo * 0.1 : 0;
      if (fromTypo >= fromOverlap && fromTypo > 0) { score = fromTypo; why = "faute de frappe probable"; }
      else if (fromOverlap > 0) { score = fromOverlap; why = "recouvrement partiel de mots"; }
    }
    if (score > 0) out.push({ value, score, why });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface OrgResolution {
  /** decisive : un candidat s'impose. ambiguous : plusieurs plausibles. none : rien de crédible. */
  kind: "decisive" | "ambiguous" | "none";
  best: OrgMatch | null;
  candidates: OrgMatch[];
}

/**
 * POLITIQUE de résolution : auto-choisir SEULEMENT quand un candidat s'impose (score fort ET
 * nettement devant le suivant). Sinon, remonter les candidats — préciser coûte une question,
 * fusionner deux sociétés différentes coûte une erreur de gouvernance.
 */
export function resolveOrg(query: string, candidates: string[]): OrgResolution {
  const ranked = rankOrgCandidates(query, candidates).slice(0, 8);
  if (!ranked.length) return { kind: "none", best: null, candidates: [] };
  const [top, second] = ranked;
  // Plusieurs GRAPHIES de la même société (mêmes jetons de cœur) comptent comme UN candidat.
  const sameCore = second && coreTokens(top.value).join(" ") === coreTokens(second.value).join(" ");
  const decisive = top.score >= 0.8 && (!second || sameCore || top.score - second.score >= 0.2);
  return { kind: decisive ? "decisive" : "ambiguous", best: top, candidates: ranked };
}
