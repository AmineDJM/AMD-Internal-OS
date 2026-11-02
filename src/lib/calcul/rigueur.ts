/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE CHIFFRE NE DIT PAS (mandat 5 §39) — pur.
 *
 * Chaque moteur rend un résultat ET sa rigueur : les HYPOTHÈSES qu'il a faites, les LIMITES de la
 * méthode, les AVERTISSEMENTS que les données ont levés. Un P90 sans le nombre de tirages, une
 * régression sans le R², un optimum sans dire qu'il est entier ou relâché : c'est un chiffre qui
 * a l'air sûr. Ici, les statistiques de base partagées et les aides de format — un seul endroit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Rigueur {
  hypotheses: string[];
  limites: string[];
  avertissements: string[];
}

export const rigueurVide = (): Rigueur => ({ hypotheses: [], limites: [], avertissements: [] });

export const moyenne = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function variance(xs: readonly number[], echantillon = true): number {
  const n = xs.length;
  if (n < (echantillon ? 2 : 1)) return NaN;
  const m = moyenne(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (echantillon ? n - 1 : n);
}

export const ecartType = (xs: readonly number[], echantillon = true): number => Math.sqrt(variance(xs, echantillon));

/** Le percentile p ∈ [0,100] d'un tableau DÉJÀ TRIÉ (interpolation linéaire, méthode 7 de R). */
export function percentileTrie(tries: readonly number[], p: number): number {
  const n = tries.length;
  if (!n) return NaN;
  if (n === 1) return tries[0]!;
  const h = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const i = Math.floor(h);
  const f = h - i;
  return i + 1 < n ? tries[i]! + f * (tries[i + 1]! - tries[i]!) : tries[n - 1]!;
}

export const percentile = (xs: readonly number[], p: number): number => percentileTrie([...xs].sort((a, b) => a - b), p);
export const mediane = (xs: readonly number[]): number => percentile(xs, 50);

/** Les rangs moyens (ex æquo partagés) — pour Spearman et les tests non paramétriques. */
export function rangs(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j += 1;
    const rang = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[idx[k]![1]] = rang;
    i = j + 1;
  }
  return r;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = moyenne(xs.slice(0, n)), my = moyenne(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) { const dx = xs[i]! - mx, dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export const spearman = (xs: readonly number[], ys: readonly number[]): number => pearson(rangs(xs), rangs(ys));

/** Un nombre lisible : pas de 12,345678901 dans une réponse — mais jamais arrondi avant le calcul. */
export function arrondi(x: number, decimales = 2): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** decimales;
  return Math.round(x * f) / f;
}

/** Arrondi « intelligent » : 3 chiffres significatifs pour les petits nombres, l'entier pour les grands. */
export function arrondiLisible(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const ordre = Math.floor(Math.log10(Math.abs(x)));
  if (ordre >= 4) return Math.round(x);
  return arrondi(x, Math.max(0, 3 - ordre - 1));
}

/** Une matrice de corrélation lisible depuis une liste de paires (symétrique, diagonale 1). */
export function matriceDepuisPaires(noms: readonly string[], paires: readonly { a: string; b: string; rho: number }[]): number[][] {
  const n = noms.length;
  const m: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)));
  for (const p of paires) {
    const i = noms.indexOf(p.a), j = noms.indexOf(p.b);
    if (i < 0 || j < 0 || i === j) continue;
    m[i]![j] = p.rho; m[j]![i] = p.rho;
  }
  return m;
}

/** Tri ascendant sans muter l'entrée. */
export const trie = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);
