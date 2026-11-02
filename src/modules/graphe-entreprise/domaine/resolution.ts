/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSOLUTION D'ENTITÉS DU GRAPHE (J9, décision 0021) — règle PURE.
 *
 * Une mention (« Saidal », « مجمع صيدال », « ENPP », « Mohamed Benaly », « 000116001234567 ») → la fiche canonique. Les
 * preuves, de la plus forte à la plus faible :
 *
 *   identifiant  NIF / RC / NIS / code lu tel quel (chiffres et lettres) — une clé, pas une ressemblance ;
 *   exact        la graphie repliée est celle d'un nom ou d'un alias ;
 *   ordre        les mêmes mots dans un autre ordre (« BENALI Ahmed » / « Ahmed Benali ») ;
 *   phonetique   les mêmes mots à la graphie latine près (Mohammed / Mohamed, Khalid / Khaled) ;
 *   squelette    les mêmes consonnes — c'est le pont entre l'arabe et le latin ;
 *   sigle        « ENPP » pour « Entreprise Nationale des Produits Pharmaceutiques » ;
 *   faute        une à deux lettres près (« Benaly », « Sadial ») ;
 *   partiel      la mention ne nomme qu'une partie (« Benali » pour « Ahmed Benali »).
 *
 * LE VERDICT n'invente pas de certitude : deux candidats proches font une question (AMBIGU), jamais un choix au hasard.
 * L'index (`indexer`) ne fait que trouver les candidats vite ; il ne décide rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { motPhonetique, motsDuNom, plier } from "@/modules/referentiels/partage";
import { squelette, translitterer } from "./translitteration";

export interface CandidatEntite {
  ref: string;
  type: string;
  libelle: string;
  /** Autres graphies connues (nom court, alias, marque, référence, DCI…). */
  alias?: readonly string[];
  /** Identifiants officiels déjà normalisés (`[0-9A-Z]`). */
  identifiants?: readonly string[];
  detail?: string | null;
  /** La fiche qui ABSORBE celle-ci quand les deux répondent (un dossier réglementaire → son produit). */
  parent?: string | null;
}

export type PreuveResolution = "identifiant" | "exact" | "ordre" | "phonetique" | "squelette" | "sigle" | "faute" | "partiel";
export type VerdictResolution = "CERTAIN" | "PROBABLE" | "AMBIGU" | "INCONNU";

export interface CandidatNote { candidat: CandidatEntite; score: number; preuve: PreuveResolution; graphie: string }
export interface Resolution { verdict: VerdictResolution; retenu: CandidatNote | null; candidats: CandidatNote[] }

export const SEUILS_RESOLUTION = { certain: 0.88, probable: 0.7, ecart: 0.06 } as const;

/** Les mots qui ne nomment personne en particulier : formes juridiques, natures d'établissement, liaisons. */
const GENERIQUES = new Set((
  "societe ste groupe grp entreprise ets etablissement etablissements sarl spa eurl snc sas sa cie compagnie "
  + "laboratoire laboratoires labo labos hopital chu eph ehs epsp centre universitaire hospitalo hospitalier clinique "
  + "pharmacie pharmaceutique pharmaceutiques pharma national nationale algerie algerien algerienne international "
  + "pharmaceutical pharmaceuticals manufacturing industrie industries industry company group limited ltd "
  + "mg ml g cp comprime comprimes gelule gelules injectable flacon boite "
  + "de des du la le les et d l en au aux pour import export distribution"
).split(" "));

const MOTS_SIGLE_VIDES = new Set("de des du la le les et d l en au aux pour".split(" "));

/** Les mots d'une mention, prêts à comparer : translittérés, pliés, particules attachées (règle des référentiels). */
export function motsCompares(texte: string): string[] {
  // « Ez-Zohra », « Er-Rahmane » : l'article assimilé s'attache comme « el » (les référentiels connaissent es/et/ed).
  return motsDuNom(translitterer(texte).replace(/(^|[\s-])(ez|er)[\s-]+(?=[a-z])/gi, "$1el"));
}

const significatifs = (mots: readonly string[]) => {
  const s = mots.filter((m) => !GENERIQUES.has(m));
  return s.length ? s : [...mots];
};

/** Le sigle d'un nom : l'initiale de chaque mot plein (« Entreprise Nationale des Produits Pharmaceutiques » → enpp). */
export function sigle(texte: string): string {
  const mots = plier(translitterer(texte)).split(" ").filter((m) => m && !MOTS_SIGLE_VIDES.has(m));
  return mots.length >= 2 ? mots.map((m) => m[0]).join("") : "";
}

/** Un identifiant officiel tel qu'il se compare : chiffres et lettres, majuscules ; au moins six chiffres. */
export function identifiantDe(texte: string): string | null {
  const s = translitterer(texte).toUpperCase()
    .replace(/^\s*(NIF|NIS|RC|AI|ART|N°|NO|NUM(ERO)?|CODE)\b[\s.:°-]*/g, "")
    .replace(/[^0-9A-Z]/g, "");
  return (s.match(/\d/g)?.length ?? 0) >= 6 && s.length <= 24 ? s : null;
}

/** Distance d'édition (transpositions comprises), bornée : au-delà de `max`, rend `max + 1`. */
export function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length; const m = b.length;
  let pp: number[] = []; let p = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const c = [i];
    let min = i;
    for (let j = 1; j <= m; j++) {
      const cout = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p[j]! + 1, c[j - 1]! + 1, p[j - 1]! + cout);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2]! + 1);
      c.push(v);
      if (v < min) min = v;
    }
    if (min > max) return max + 1;
    pp = p; p = c;
  }
  return p[m]!;
}

/** Deux mots sont-ils le même à une faute près ? (≥ 5 lettres : une faute ; ≥ 9 : deux) */
const procheParFaute = (a: string, b: string): boolean => {
  const l = Math.min(a.length, b.length);
  if (l < 5) return false;
  return distance(a, b, 2) <= (l >= 9 ? 2 : 1);
};

interface FormeNom { brut: string; plie: string; mots: string[]; tri: string; phon: string; sq: string; sig: string; signif: string[]; nums: string; compact: string }

export function forme(texte: string): FormeNom {
  const mots = motsCompares(texte);
  const signif = significatifs(mots);
  const plie = plier(translitterer(texte));
  return {
    brut: texte,
    plie,
    // Les nombres d'une graphie (« PRD-2026-002 », « Nivolumab 100 mg ») : deux codes qui ne diffèrent que par eux ne se ressemblent pas.
    nums: plie.split(" ").filter((m) => /^\d+$/.test(m)).sort().join(" "),
    compact: [...signif].sort().join(""),
    mots,
    tri: [...signif].sort().join(" "),
    phon: signif.map(motPhonetique).filter(Boolean).sort().join(" "),
    sq: signif.map(squelette).filter(Boolean).sort().join(" "),
    sig: sigle(texte),
    signif,
  };
}

/** Le score d'UNE graphie candidate face à la mention, et sa meilleure preuve. */
function noterGraphie(q: FormeNom, c: FormeNom): { score: number; preuve: PreuveResolution } | null {
  if (!q.plie || !c.plie) return null;
  if (q.plie === c.plie) return { score: 1, preuve: "exact" };
  if (q.nums && q.nums !== c.nums) return null;
  if (q.tri && q.tri === c.tri) return { score: 0.97, preuve: "ordre" };
  if (q.phon && q.phon === c.phon) return { score: 0.93, preuve: "phonetique" };
  if (q.sq && q.sq === c.sq && q.signif.length === c.signif.length) return { score: 0.9, preuve: "squelette" };
  // Le sigle : une mention d'un seul mot court contre l'initiale des mots du nom (ou l'inverse).
  const qCompact = q.plie.replace(/\s+/g, "");
  if (q.mots.length === 1 && qCompact.length >= 2 && qCompact.length <= 7 && c.sig && qCompact === c.sig) return { score: 0.9, preuve: "sigle" };
  if (c.mots.length === 1 && q.sig && c.plie.replace(/\s+/g, "") === q.sig) return { score: 0.88, preuve: "sigle" };

  // Mot à mot : chaque mot plein de la mention trouve son pareil dans le nom (graphie, phonétique, squelette, faute).
  const qs = q.signif; const cs = [...c.signif];
  let exacts = 0; let fautes = 0; let apparies = 0;
  for (const m of qs) {
    const pm = motPhonetique(m); const sm = squelette(m);
    let k = cs.findIndex((x) => x === m);
    if (k >= 0) exacts++;
    else {
      k = cs.findIndex((x) => motPhonetique(x) === pm || (sm.length >= 3 && squelette(x) === sm));
      if (k < 0) { k = cs.findIndex((x) => procheParFaute(x, m) || procheParFaute(motPhonetique(x), pm)); if (k >= 0) fautes++; }
    }
    if (k >= 0) { apparies++; cs.splice(k, 1); }
  }
  if (!qs.length || apparies < qs.length) {
    // Faute sur le nom entier (« sadial » / « saidal ») quand les mots ne s'alignent pas.
    const a = q.tri.replace(/\s+/g, ""); const b = c.tri.replace(/\s+/g, "");
    if (a.length >= 5 && b.length >= 5) {
      const d = distance(a, b, 2);
      const l = Math.max(a.length, b.length);
      if (d <= (l >= 9 ? 2 : 1)) return { score: 0.86 - 0.04 * d, preuve: "faute" };
    }
    return null;
  }
  const couverture = qs.length / Math.max(qs.length, c.signif.length);
  if (couverture === 1) {
    if (fautes === 0) return { score: exacts === qs.length ? 0.96 : 0.9, preuve: exacts === qs.length ? "ordre" : "phonetique" };
    return { score: Math.max(0.74, 0.9 - 0.06 * fautes), preuve: "faute" };
  }
  // Partiel : la mention ne nomme qu'une partie. Jamais « certain » à elle seule.
  return { score: Math.min(0.8, 0.55 + 0.3 * couverture - 0.05 * fautes), preuve: "partiel" };
}

/** Note un candidat : la meilleure de ses graphies (nom, alias), ou son identifiant. */
export function noterCandidat(mention: string, c: CandidatEntite, formeMention: FormeNom = forme(mention)): CandidatNote | null {
  const ident = identifiantDe(mention);
  if (ident && (c.identifiants ?? []).includes(ident)) return { candidat: c, score: 1, preuve: "identifiant", graphie: ident };
  let meilleur: CandidatNote | null = null;
  for (const g of [c.libelle, ...(c.alias ?? [])]) {
    if (!g) continue;
    const n = noterGraphie(formeMention, forme(g));
    if (n && (!meilleur || n.score > meilleur.score)) meilleur = { candidat: c, score: n.score, preuve: n.preuve, graphie: g };
  }
  return meilleur;
}

/**
 * TRANCHE. Deux candidats qui désignent la même fiche (un nom et son alias) ne font qu'un. CERTAIN exige une preuve forte
 * ET un écart ; un partiel n'est jamais certain.
 */
export function trancher(notes: readonly CandidatNote[], limite = 5): Resolution {
  const parRef = new Map<string, CandidatNote>();
  for (const n of notes) { const d = parRef.get(n.candidat.ref); if (!d || n.score > d.score) parRef.set(n.candidat.ref, n); }
  // « Daclatasvir » nomme le produit ET son dossier : le produit absorbe son dossier s'il répond presque aussi bien.
  for (const n of [...parRef.values()]) {
    const p = n.candidat.parent ? parRef.get(n.candidat.parent) : undefined;
    if (p && p.score >= n.score - SEUILS_RESOLUTION.ecart) parRef.delete(n.candidat.ref);
  }
  const tri = [...parRef.values()].sort((a, b) => b.score - a.score || a.candidat.libelle.localeCompare(b.candidat.libelle)).slice(0, limite);
  const [a, b] = tri;
  if (!a || a.score < SEUILS_RESOLUTION.probable) return { verdict: "INCONNU", retenu: null, candidats: tri };
  const ecart = a.score - (b?.score ?? 0);
  if (ecart < SEUILS_RESOLUTION.ecart) return { verdict: "AMBIGU", retenu: null, candidats: tri };
  const certain = a.score >= SEUILS_RESOLUTION.certain && a.preuve !== "partiel";
  return { verdict: certain ? "CERTAIN" : "PROBABLE", retenu: a, candidats: tri };
}

// ─────────────────────────────── L'index — trouver les candidats vite ───────────────────────────────

export interface IndexEntites {
  candidats: CandidatEntite[];
  /** clé (mot plié, phonétique, squelette, sigle, identifiant) → indices des candidats. */
  cles: Map<string, number[]>;
  /** Les mots distincts (phonétiques) — parcourus pour les fautes. */
  mots: string[];
}

function clesDe(c: CandidatEntite): string[] {
  const out = new Set<string>();
  for (const g of [c.libelle, ...(c.alias ?? [])]) {
    if (!g) continue;
    const f = forme(g);
    for (const m of f.signif) { out.add(`m:${m}`); out.add(`p:${motPhonetique(m)}`); const s = squelette(m); if (s.length >= 2) out.add(`s:${s}`); }
    if (f.sig) out.add(`g:${f.sig}`);
    if (f.mots.length === 1) out.add(`g:${f.plie.replace(/\s+/g, "")}`);
    if (f.compact.length >= 5) out.add(`c:${f.compact}`);
  }
  for (const i of c.identifiants ?? []) out.add(`i:${i}`);
  return [...out];
}

export function indexer(candidats: readonly CandidatEntite[]): IndexEntites {
  const cles = new Map<string, number[]>();
  candidats.forEach((c, i) => {
    for (const k of clesDe(c)) { const l = cles.get(k); if (l) l.push(i); else cles.set(k, [i]); }
  });
  const mots = [...cles.keys()].filter((k) => k.startsWith("p:")).map((k) => k.slice(2));
  return { candidats: [...candidats], cles, mots };
}

/** Résout une mention dans un index ; `filtre` écarte d'avance ce que la personne ne peut pas voir. */
export function resoudreDans(index: IndexEntites, mention: string, opts: { types?: readonly string[]; filtre?: (c: CandidatEntite) => boolean; limite?: number } = {}): Resolution {
  const f = forme(mention);
  const vus = new Set<number>();
  const ajouter = (k: string) => { for (const i of index.cles.get(k) ?? []) vus.add(i); };
  const ident = identifiantDe(mention);
  if (ident) ajouter(`i:${ident}`);
  for (const m of f.signif) {
    ajouter(`m:${m}`);
    const pm = motPhonetique(m);
    ajouter(`p:${pm}`);
    const s = squelette(m); if (s.length >= 2) ajouter(`s:${s}`);
    if (pm.length >= 5) for (const w of index.mots) if (w !== pm && procheParFaute(w, pm)) ajouter(`p:${w}`);
  }
  const compact = f.plie.replace(/\s+/g, "");
  if (compact) ajouter(`g:${compact}`);
  if (f.compact.length >= 5) ajouter(`c:${f.compact}`);
  if (f.sig) ajouter(`g:${f.sig}`);
  const notes: CandidatNote[] = [];
  for (const i of vus) {
    const c = index.candidats[i]!;
    if (opts.types?.length && !opts.types.includes(c.type)) continue;
    if (opts.filtre && !opts.filtre(c)) continue;
    const n = noterCandidat(mention, c, f);
    if (n) notes.push(n);
  }
  return trancher(notes, opts.limite ?? 5);
}
