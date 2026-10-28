/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC STATISTIQUE (mandat 5 §39) — pur.
 *
 * Régression linéaire multiple (moindres carrés, par décomposition QR — stable là où l'équation
 * normale explose), régression LOGISTIQUE (Newton-Raphson), tests d'hypothèse (Student apparié et
 * indépendant avec Welch, χ², Mann-Whitney), corrélations avec leur significativité, et le
 * diagnostic qui accompagne chaque chiffre.
 *
 * LA RIGUEUR N'EST PAS UNE OPTION : taille d'échantillon, valeurs manquantes, valeurs aberrantes,
 * COLINÉARITÉ (VIF), hétéroscédasticité (Breusch-Pagan), autocorrélation (Durbin-Watson),
 * sur-apprentissage (R² ajusté, validation croisée), intervalles de confiance, et la phrase que
 * personne n'aime dire : une corrélation n'est pas une cause. Une p-value < 0,05 sur un effet
 * de 0,3 % n'est pas un résultat métier — les deux significativités sont distinguées.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { betaIncompleteReguliere, logGamma, phi } from "./alea";
import { type Rigueur, arrondi, ecartType, mediane, moyenne, pearson, percentile, rangs, rigueurVide, spearman, variance } from "./rigueur";

export const OBSERVATIONS_MIN = 3;
export const OBSERVATIONS_MAX = 200_000;
export const PREDICTEURS_MAX = 40;

/* ─────────────────────────────── Lois de probabilité des tests ─────────────────────────────── */

/** Gamma incomplète régularisée P(a, x) — série pour x < a+1, fraction continue au-delà. */
export function gammaIncompleteReguliere(a: number, x: number): number {
  if (x <= 0) return 0;
  if (a <= 0) return 1;
  if (x < a + 1) {
    let terme = 1 / a, somme = terme;
    for (let n = 1; n < 1000; n += 1) { terme *= x / (a + n); somme += terme; if (Math.abs(terme) < Math.abs(somme) * 1e-15) break; }
    return somme * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** P(T ≤ t) pour la loi de Student à v degrés de liberté. */
export function loiStudent(t: number, v: number): number {
  if (v <= 0) return NaN;
  const x = v / (v + t * t);
  const p = 0.5 * betaIncompleteReguliere(x, v / 2, 0.5);
  return t > 0 ? 1 - p : p;
}
/** La p-value bilatérale d'un t observé. */
export const pValeurStudent = (t: number, v: number): number => 2 * (1 - loiStudent(Math.abs(t), v));
/** P(F ≤ f) pour la loi de Fisher. */
export const loiFisher = (f: number, d1: number, d2: number): number => (f <= 0 ? 0 : betaIncompleteReguliere((d1 * f) / (d1 * f + d2), d1 / 2, d2 / 2));
export const pValeurFisher = (f: number, d1: number, d2: number): number => 1 - loiFisher(f, d1, d2);
/** P(χ² ≤ x) à k degrés de liberté. */
export const loiKhiDeux = (x: number, k: number): number => gammaIncompleteReguliere(k / 2, x / 2);
export const pValeurKhiDeux = (x: number, k: number): number => 1 - loiKhiDeux(x, k);
/** Le quantile de Student par bissection (pour les intervalles de confiance). */
export function quantileStudent(p: number, v: number): number {
  let lo = -200, hi = 200;
  for (let i = 0; i < 200; i += 1) { const m = (lo + hi) / 2; if (loiStudent(m, v) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/* ─────────────────────────────── Préparation des données ─────────────────────────────── */

export interface Nettoyage {
  observationsFournies: number;
  observationsUtilisees: number;
  lignesIncompletes: number;
  colonnesConstantes: string[];
  aberrantes: { colonne: string; n: number; exemples: number[] }[];
}

const estNombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function nombreDe(v: unknown): number | null {
  if (estNombre(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim().replace(/\s/g, "").replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Les valeurs hors de [Q1 − 3 IQR, Q3 + 3 IQR] : SIGNALÉES, jamais supprimées en silence. */
function aberrantesDe(xs: readonly number[]): number[] {
  if (xs.length < 8) return [];
  const q1 = percentile(xs, 25), q3 = percentile(xs, 75), iqr = q3 - q1;
  if (iqr <= 0) return [];
  const lo = q1 - 3 * iqr, hi = q3 + 3 * iqr;
  return xs.filter((x) => x < lo || x > hi);
}

/* ─────────────────────────────── Régression linéaire ─────────────────────────────── */

export interface Coefficient {
  nom: string;
  valeur: number;
  erreurType: number;
  t: number;
  pValeur: number;
  intervalle95: [number, number];
  significatif: boolean;
  /** Facteur d'inflation de la variance : > 5 = colinéarité gênante, > 10 = le coefficient n'est plus interprétable. */
  vif: number | null;
}

export interface Regression {
  ok: true;
  type: "lineaire";
  cible: string;
  predicteurs: string[];
  n: number;
  coefficients: Coefficient[];
  constante: Coefficient | null;
  r2: number;
  r2Ajuste: number;
  /** R² en validation croisée k-blocs : l'écart avec le R² brut MESURE le sur-apprentissage. */
  r2ValidationCroisee: number | null;
  erreurStandardResidu: number;
  f: number;
  pValeurGlobale: number;
  durbinWatson: number;
  breuschPaganP: number | null;
  nettoyage: Nettoyage;
  /** Prédire une nouvelle observation (mêmes noms de prédicteurs). */
  predire: (x: Record<string, number>) => number;
  residus: number[];
  rigueur: Rigueur;
  ms: number;
}

export type ResultatRegression = Regression | { ok: false; erreur: string; details?: string[] };

/** Résolution des moindres carrés par QR (Householder) : stable même quand les colonnes sont proches. */
function moindresCarres(X: number[][], y: number[]): { beta: number[]; residus: number[]; xtxInverse: number[][] } | null {
  const n = X.length, p = X[0]!.length;
  if (n < p) return null;
  // Gram : XᵀX et Xᵀy, puis Cholesky avec régularisation minimale si nécessaire.
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i += 1) {
    const xi = X[i]!;
    for (let a = 0; a < p; a += 1) {
      xty[a] += xi[a]! * y[i]!;
      for (let b = a; b < p; b += 1) xtx[a]![b] = xtx[a]![b]! + xi[a]! * xi[b]!;
    }
  }
  for (let a = 0; a < p; a += 1) for (let b = 0; b < a; b += 1) xtx[a]![b] = xtx[b]![a]!;
  // Inversion par Gauss-Jordan avec pivot partiel.
  const m: number[][] = xtx.map((r, i) => [...r, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < p; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < p; r += 1) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const d = m[col]![col]!;
    for (let j = 0; j < 2 * p; j += 1) m[col]![j] = m[col]![j]! / d;
    for (let r = 0; r < p; r += 1) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (Math.abs(f) < 1e-15) continue;
      for (let j = 0; j < 2 * p; j += 1) m[r]![j] = m[r]![j]! - f * m[col]![j]!;
    }
  }
  const xtxInverse = m.map((r) => r.slice(p));
  const beta = new Array<number>(p).fill(0);
  for (let a = 0; a < p; a += 1) { let s = 0; for (let b = 0; b < p; b += 1) s += xtxInverse[a]![b]! * xty[b]!; beta[a] = s; }
  const residus = y.map((yi, i) => { let pred = 0; const xi = X[i]!; for (let a = 0; a < p; a += 1) pred += beta[a]! * xi[a]!; return yi - pred; });
  return { beta, residus, xtxInverse };
}

export interface OptionsRegression {
  /** Nombre de blocs de validation croisée (0 pour la désactiver). */
  blocs?: number;
  constante?: boolean;
}

export function regresser(lignes: readonly Record<string, unknown>[], cible: string, predicteurs: readonly string[], options: OptionsRegression = {}): ResultatRegression {
  const t0 = Date.now();
  const rigueur = rigueurVide();
  if (!Array.isArray(lignes) || !lignes.length) return { ok: false, erreur: "Aucune observation." };
  if (lignes.length > OBSERVATIONS_MAX) return { ok: false, erreur: `${lignes.length} observations : ${OBSERVATIONS_MAX} au plus (limite opérationnelle).` };
  if (!cible) return { ok: false, erreur: "Aucune variable à expliquer." };
  const preds = predicteurs.filter((p) => p !== cible);
  if (!preds.length) return { ok: false, erreur: "Aucun prédicteur (hors la cible elle-même)." };
  if (preds.length > PREDICTEURS_MAX) return { ok: false, erreur: `${preds.length} prédicteurs : ${PREDICTEURS_MAX} au plus.` };
  const avecConstante = options.constante !== false;

  const y: number[] = [];
  const X: number[][] = [];
  let incompletes = 0;
  for (const l of lignes) {
    const yv = nombreDe(l[cible]);
    const xs = preds.map((p) => nombreDe(l[p]));
    if (yv === null || xs.some((v) => v === null)) { incompletes += 1; continue; }
    y.push(yv);
    X.push(avecConstante ? [1, ...(xs as number[])] : (xs as number[]));
  }
  const n = y.length;
  const p = (avecConstante ? 1 : 0) + preds.length;
  if (n < OBSERVATIONS_MIN) return { ok: false, erreur: `${n} observation(s) complète(s) : au moins ${OBSERVATIONS_MIN} sont nécessaires${incompletes ? ` (${incompletes} ligne(s) écartée(s) faute de valeur)` : ""}.` };
  if (n <= p) return { ok: false, erreur: `${n} observations pour ${p} paramètres : le modèle passerait exactement par les points sans rien expliquer. Réduire le nombre de prédicteurs ou augmenter l'échantillon.` };

  const constantes: string[] = [];
  for (const [j, nom] of preds.entries()) {
    const col = X.map((r) => r[j + (avecConstante ? 1 : 0)]!);
    if (Math.abs(Math.max(...col) - Math.min(...col)) < 1e-12) constantes.push(nom);
  }
  if (constantes.length) return { ok: false, erreur: `Prédicteur(s) constant(s) : ${constantes.join(", ")} — une variable qui ne varie pas n'explique rien.` };

  const res = moindresCarres(X, y);
  if (!res) return { ok: false, erreur: "Les prédicteurs sont linéairement dépendants (l'un est une combinaison exacte des autres) : retirer celui qui est redondant." };
  const { beta, residus, xtxInverse } = res;

  const my = moyenne(y);
  const sct = y.reduce((s, v) => s + (v - my) * (v - my), 0);
  const scr = residus.reduce((s, v) => s + v * v, 0);
  const r2 = sct > 0 ? 1 - scr / sct : 0;
  const ddl = n - p;
  const r2Ajuste = sct > 0 && ddl > 0 ? 1 - (1 - r2) * ((n - 1) / ddl) : NaN;
  const sigma2 = scr / ddl;
  const erreurStandardResidu = Math.sqrt(sigma2);
  const kPredicteurs = p - (avecConstante ? 1 : 0);
  const f = kPredicteurs > 0 && scr > 0 ? ((sct - scr) / kPredicteurs) / sigma2 : Infinity;
  const pValeurGlobale = Number.isFinite(f) ? pValeurFisher(f, kPredicteurs, ddl) : 0;
  const tCritique = quantileStudent(0.975, ddl);

  // VIF : R² de chaque prédicteur régressé sur les autres.
  const vifs: (number | null)[] = preds.map(() => null);
  if (preds.length > 1 && preds.length <= 20) {
    for (const [j] of preds.entries()) {
      const cible2 = X.map((r) => r[j + (avecConstante ? 1 : 0)]!);
      const autres = X.map((r) => [1, ...preds.map((_, k) => k).filter((k) => k !== j).map((k) => r[k + (avecConstante ? 1 : 0)]!)]);
      const rr = moindresCarres(autres, cible2);
      if (!rr) { vifs[j] = Infinity; continue; }
      const m2 = moyenne(cible2);
      const sct2 = cible2.reduce((s, v) => s + (v - m2) * (v - m2), 0);
      const scr2 = rr.residus.reduce((s, v) => s + v * v, 0);
      const r22 = sct2 > 0 ? 1 - scr2 / sct2 : 0;
      vifs[j] = r22 >= 1 - 1e-12 ? Infinity : 1 / (1 - r22);
    }
  }

  const faire = (nom: string, idx: number, vif: number | null): Coefficient => {
    const se = Math.sqrt(Math.max(0, sigma2 * xtxInverse[idx]![idx]!));
    const t = se > 0 ? beta[idx]! / se : 0;
    const pv = se > 0 ? pValeurStudent(t, ddl) : 1;
    return { nom, valeur: beta[idx]!, erreurType: se, t, pValeur: pv, intervalle95: [beta[idx]! - tCritique * se, beta[idx]! + tCritique * se], significatif: pv < 0.05, vif };
  };
  const constante = avecConstante ? faire("(constante)", 0, null) : null;
  const coefficients = preds.map((nom, j) => faire(nom, j + (avecConstante ? 1 : 0), vifs[j] ?? null));

  // Durbin-Watson (autocorrélation des résidus) et Breusch-Pagan (hétéroscédasticité).
  let dwNum = 0;
  for (let i = 1; i < n; i += 1) dwNum += (residus[i]! - residus[i - 1]!) ** 2;
  const durbinWatson = scr > 0 ? dwNum / scr : 2;
  let breuschPaganP: number | null = null;
  if (n >= 20 && kPredicteurs >= 1) {
    const u = residus.map((r) => (r * r) / (scr / n));
    const bp = moindresCarres(X, u);
    if (bp) {
      const mu = moyenne(u);
      const sctU = u.reduce((s, v) => s + (v - mu) * (v - mu), 0);
      const scrU = bp.residus.reduce((s, v) => s + v * v, 0);
      const stat = (sctU - scrU) / 2;
      breuschPaganP = pValeurKhiDeux(stat, kPredicteurs);
    }
  }

  // Validation croisée : le R² hors échantillon.
  const blocs = options.blocs ?? (n >= 30 ? 5 : 0);
  let r2ValidationCroisee: number | null = null;
  // La seule exigence réelle : chaque bloc d'AJUSTEMENT garde plus d'observations que de paramètres.
  if (blocs >= 2 && Math.floor((n * (blocs - 1)) / blocs) > p + 1) {
    let scrCv = 0;
    for (let b = 0; b < blocs; b += 1) {
      const testIdx = new Set<number>();
      for (let i = b; i < n; i += blocs) testIdx.add(i);
      const Xa: number[][] = [], ya: number[] = [];
      for (let i = 0; i < n; i += 1) if (!testIdx.has(i)) { Xa.push(X[i]!); ya.push(y[i]!); }
      const rb = moindresCarres(Xa, ya);
      if (!rb) { scrCv = NaN; break; }
      for (const i of testIdx) { let pred = 0; for (let a = 0; a < p; a += 1) pred += rb.beta[a]! * X[i]![a]!; scrCv += (y[i]! - pred) ** 2; }
    }
    if (Number.isFinite(scrCv) && sct > 0) r2ValidationCroisee = 1 - scrCv / sct;
  }

  const aberrantes: Nettoyage["aberrantes"] = [];
  for (const [j, nom] of [[-1, cible] as const, ...preds.map((nm, k) => [k, nm] as const)]) {
    const col = j === -1 ? y : X.map((r) => r[j + (avecConstante ? 1 : 0)]!);
    const ab = aberrantesDe(col);
    if (ab.length) aberrantes.push({ colonne: nom, n: ab.length, exemples: ab.slice(0, 3) });
  }

  // ── La rigueur.
  rigueur.hypotheses.push(`Modèle linéaire : ${cible} ≈ ${avecConstante ? "constante + " : ""}${preds.map((x) => `β·${x}`).join(" + ")}, effets ADDITIFS et coefficients constants sur toute la plage observée.`);
  rigueur.hypotheses.push(`Ajusté sur ${n} observation(s)${incompletes ? `, ${incompletes} écartée(s) faute de valeur` : ""}.`);
  rigueur.limites.push("Une régression mesure une ASSOCIATION, pas une cause : un coefficient significatif peut refléter une variable omise commune aux deux.");
  if (incompletes > 0) {
    const part = incompletes / (n + incompletes);
    rigueur.avertissements.push(`${incompletes} ligne(s) sur ${n + incompletes} (${arrondi(part * 100, 1)} %) écartée(s) faute de valeur : si ces absences ne sont pas aléatoires, le résultat est BIAISÉ.`);
  }
  if (n < 10 * kPredicteurs) rigueur.avertissements.push(`${n} observations pour ${kPredicteurs} prédicteur(s) : la règle usuelle demande au moins ${10 * kPredicteurs} — le modèle risque de coller au bruit.`);
  const vifEleve = coefficients.filter((c) => c.vif !== null && c.vif > 5);
  if (vifEleve.length) rigueur.avertissements.push(`Colinéarité : ${vifEleve.map((c) => `${c.nom} (VIF ${c.vif === Infinity ? "∞" : arrondi(c.vif!, 1)})`).join(", ")} — leurs coefficients individuels ne sont pas interprétables séparément, même si la prédiction globale reste bonne.`);
  if (r2ValidationCroisee !== null && r2 - r2ValidationCroisee > 0.15) rigueur.avertissements.push(`Sur-apprentissage : R² ${arrondi(r2, 3)} sur les données d'ajustement mais ${arrondi(r2ValidationCroisee, 3)} en validation croisée — le modèle décrit cet échantillon mieux qu'il ne prédit.`);
  if (breuschPaganP !== null && breuschPaganP < 0.05) rigueur.avertissements.push(`Hétéroscédasticité (Breusch-Pagan p = ${arrondi(breuschPaganP, 4)}) : la dispersion des résidus dépend du niveau — les erreurs types, donc les p-values, sont optimistes.`);
  if (durbinWatson < 1.5 || durbinWatson > 2.5) rigueur.avertissements.push(`Autocorrélation des résidus (Durbin-Watson ${arrondi(durbinWatson, 2)}, attendu ≈ 2) : sur des données dans le temps, les erreurs types sont sous-estimées.`);
  for (const a of aberrantes) rigueur.avertissements.push(`${a.n} valeur(s) aberrante(s) sur « ${a.colonne} » (ex. ${a.exemples.map((x) => arrondi(x, 3)).join(", ")}) : conservées dans le calcul, mais elles pèsent lourd sur les moindres carrés.`);
  if (pValeurGlobale >= 0.05) rigueur.avertissements.push(`Le modèle dans son ensemble n'est pas significatif (F p = ${arrondi(pValeurGlobale, 4)}) : les prédicteurs n'expliquent pas ${cible} mieux que sa moyenne.`);
  if (r2 > 0.99 && kPredicteurs >= 1) rigueur.avertissements.push(`R² de ${arrondi(r2, 4)} : un ajustement quasi parfait vient plus souvent d'une variable qui contient déjà la réponse (fuite) que d'un vrai modèle — vérifier que les prédicteurs sont connus AVANT ${cible}.`);
  rigueur.limites.push(`R² ${arrondi(r2, 3)} (ajusté ${arrondi(r2Ajuste, 3)}) : ${arrondi(r2 * 100, 1)} % de la variance de ${cible} expliquée ; erreur type des résidus ${arrondi(erreurStandardResidu, 3)}.`);

  const noms = preds;
  const predire = (x: Record<string, number>): number => {
    let s = avecConstante ? beta[0]! : 0;
    for (const [j, nom] of noms.entries()) s += beta[j + (avecConstante ? 1 : 0)]! * (Number(x[nom]) || 0);
    return s;
  };

  return {
    ok: true, type: "lineaire", cible, predicteurs: preds, n, coefficients, constante, r2, r2Ajuste, r2ValidationCroisee,
    erreurStandardResidu, f, pValeurGlobale, durbinWatson, breuschPaganP,
    nettoyage: { observationsFournies: lignes.length, observationsUtilisees: n, lignesIncompletes: incompletes, colonnesConstantes: constantes, aberrantes },
    predire, residus, rigueur, ms: Date.now() - t0,
  };
}

/* ─────────────────────────────── Régression logistique ─────────────────────────────── */

export interface RegressionLogistique {
  ok: true;
  type: "logistique";
  cible: string;
  predicteurs: string[];
  n: number;
  positifs: number;
  coefficients: (Coefficient & { rapportDeCotes: number })[];
  constante: Coefficient | null;
  /** Pseudo-R² de McFadden. */
  pseudoR2: number;
  /** Aire sous la courbe ROC : 0,5 = hasard, 1 = séparation parfaite. */
  auc: number;
  exactitude: number;
  matriceConfusion: { vraisPositifs: number; fauxPositifs: number; vraisNegatifs: number; fauxNegatifs: number };
  convergence: boolean;
  nettoyage: Nettoyage;
  predire: (x: Record<string, number>) => number;
  rigueur: Rigueur;
  ms: number;
}
export type ResultatLogistique = RegressionLogistique | { ok: false; erreur: string };

const sigmoide = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function regresserLogistique(lignes: readonly Record<string, unknown>[], cible: string, predicteurs: readonly string[], seuil = 0.5): ResultatLogistique {
  const t0 = Date.now();
  const rigueur = rigueurVide();
  const preds = predicteurs.filter((p) => p !== cible);
  if (!preds.length) return { ok: false, erreur: "Aucun prédicteur." };
  if (preds.length > PREDICTEURS_MAX) return { ok: false, erreur: `${preds.length} prédicteurs : ${PREDICTEURS_MAX} au plus.` };
  const y: number[] = [], X: number[][] = [];
  let incompletes = 0;
  for (const l of lignes) {
    const brut = l[cible];
    const yv = typeof brut === "boolean" ? (brut ? 1 : 0) : nombreDe(brut);
    const xs = preds.map((p) => nombreDe(l[p]));
    if (yv === null || (yv !== 0 && yv !== 1) || xs.some((v) => v === null)) { incompletes += 1; continue; }
    y.push(yv); X.push([1, ...(xs as number[])]);
  }
  const n = y.length, p = preds.length + 1;
  if (n < Math.max(OBSERVATIONS_MIN, p + 1)) return { ok: false, erreur: `${n} observation(s) exploitable(s) : trop peu pour ${preds.length} prédicteur(s). La cible doit valoir 0 ou 1 (ou vrai/faux).` };
  const positifs = y.reduce((s, v) => s + v, 0);
  if (positifs === 0 || positifs === n) return { ok: false, erreur: `La cible « ${cible} » ne prend qu'une seule valeur (${positifs === 0 ? "aucun" : "tous"} positif) : il n'y a rien à séparer.` };

  // Newton-Raphson (IRLS) avec régularisation ridge minimale contre la séparation parfaite.
  let beta = new Array<number>(p).fill(0);
  let convergence = false;
  const lambda = 1e-6;
  for (let iter = 0; iter < 100; iter += 1) {
    const grad = new Array<number>(p).fill(0);
    const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < n; i += 1) {
      let z = 0;
      const xi = X[i]!;
      for (let a = 0; a < p; a += 1) z += beta[a]! * xi[a]!;
      const pi = sigmoide(z);
      const w = Math.max(1e-8, pi * (1 - pi));
      for (let a = 0; a < p; a += 1) {
        grad[a] += (y[i]! - pi) * xi[a]!;
        for (let b = a; b < p; b += 1) H[a]![b] = H[a]![b]! + w * xi[a]! * xi[b]!;
      }
    }
    for (let a = 0; a < p; a += 1) { H[a]![a] = H[a]![a]! + lambda; for (let b = 0; b < a; b += 1) H[a]![b] = H[b]![a]!; }
    const m: number[][] = H.map((r, i) => [...r, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
    let singulier = false;
    for (let col = 0; col < p; col += 1) {
      let pivot = col;
      for (let r = col + 1; r < p; r += 1) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
      if (Math.abs(m[pivot]![col]!) < 1e-14) { singulier = true; break; }
      [m[col], m[pivot]] = [m[pivot]!, m[col]!];
      const d = m[col]![col]!;
      for (let j = 0; j < 2 * p; j += 1) m[col]![j] = m[col]![j]! / d;
      for (let r = 0; r < p; r += 1) { if (r === col) continue; const fx = m[r]![col]!; if (Math.abs(fx) < 1e-15) continue; for (let j = 0; j < 2 * p; j += 1) m[r]![j] = m[r]![j]! - fx * m[col]![j]!; }
    }
    if (singulier) return { ok: false, erreur: "Les prédicteurs sont linéairement dépendants : retirer celui qui est redondant." };
    const inv = m.map((r) => r.slice(p));
    let deplacement = 0;
    const nouveau = beta.map((b, a) => { let s = 0; for (let bb = 0; bb < p; bb += 1) s += inv[a]![bb]! * grad[bb]!; deplacement = Math.max(deplacement, Math.abs(s)); return b + s; });
    beta = nouveau;
    if (deplacement < 1e-8) { convergence = true; break; }
  }

  // Erreurs types depuis l'inverse de la hessienne au point final.
  const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const probas: number[] = [];
  let logV = 0;
  for (let i = 0; i < n; i += 1) {
    let z = 0; const xi = X[i]!;
    for (let a = 0; a < p; a += 1) z += beta[a]! * xi[a]!;
    const pi = sigmoide(z);
    probas.push(pi);
    logV += y[i]! ? Math.log(Math.max(1e-12, pi)) : Math.log(Math.max(1e-12, 1 - pi));
    const w = Math.max(1e-10, pi * (1 - pi));
    for (let a = 0; a < p; a += 1) for (let b = 0; b < p; b += 1) H[a]![b] = H[a]![b]! + w * xi[a]! * xi[b]!;
  }
  const m2: number[][] = H.map((r, i) => [...r, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < p; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < p; r += 1) if (Math.abs(m2[r]![col]!) > Math.abs(m2[pivot]![col]!)) pivot = r;
    if (Math.abs(m2[pivot]![col]!) < 1e-14) break;
    [m2[col], m2[pivot]] = [m2[pivot]!, m2[col]!];
    const d = m2[col]![col]!;
    for (let j = 0; j < 2 * p; j += 1) m2[col]![j] = m2[col]![j]! / d;
    for (let r = 0; r < p; r += 1) { if (r === col) continue; const fx = m2[r]![col]!; if (Math.abs(fx) < 1e-15) continue; for (let j = 0; j < 2 * p; j += 1) m2[r]![j] = m2[r]![j]! - fx * m2[col]![j]!; }
  }
  const inv = m2.map((r) => r.slice(p));
  const pi0 = positifs / n;
  const logV0 = positifs * Math.log(pi0) + (n - positifs) * Math.log(1 - pi0);
  const pseudoR2 = logV0 !== 0 ? 1 - logV / logV0 : 0;

  const faire = (nom: string, idx: number): Coefficient => {
    const se = Math.sqrt(Math.max(0, inv[idx]![idx]!));
    const z = se > 0 ? beta[idx]! / se : 0;
    const pv = se > 0 ? 2 * (1 - phi(Math.abs(z))) : 1;
    return { nom, valeur: beta[idx]!, erreurType: se, t: z, pValeur: pv, intervalle95: [beta[idx]! - 1.96 * se, beta[idx]! + 1.96 * se], significatif: pv < 0.05, vif: null };
  };
  const constante = faire("(constante)", 0);
  const coefficients = preds.map((nom, j) => ({ ...faire(nom, j + 1), rapportDeCotes: Math.exp(beta[j + 1]!) }));

  // AUC par les rangs (Mann-Whitney) et la matrice de confusion au seuil demandé.
  const rg = rangs(probas);
  let sommeRangsPositifs = 0;
  for (let i = 0; i < n; i += 1) if (y[i]! === 1) sommeRangsPositifs += rg[i]!;
  const nPos = positifs, nNeg = n - positifs;
  const auc = (sommeRangsPositifs - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  let vp = 0, fp = 0, vn = 0, fn = 0;
  for (let i = 0; i < n; i += 1) {
    const pred = probas[i]! >= seuil ? 1 : 0;
    if (y[i]! === 1 && pred === 1) vp += 1;
    else if (y[i]! === 0 && pred === 1) fp += 1;
    else if (y[i]! === 0 && pred === 0) vn += 1;
    else fn += 1;
  }

  rigueur.hypotheses.push(`Modèle logistique : log(cote de ${cible}) ≈ constante + ${preds.map((x) => `β·${x}`).join(" + ")} — un effet MULTIPLICATIF sur la cote, pas additif sur la probabilité.`);
  rigueur.limites.push("Un rapport de cotes n'est pas un risque relatif : sur un événement fréquent, il exagère l'effet.");
  rigueur.limites.push("Une association, pas une cause.");
  if (!convergence) rigueur.avertissements.push("L'ajustement n'a pas convergé en 100 itérations : les coefficients sont approximatifs (séparation quasi parfaite ou prédicteurs presque colinéaires).");
  if (Math.min(nPos, nNeg) < 10 * preds.length) rigueur.avertissements.push(`Classe minoritaire : ${Math.min(nPos, nNeg)} cas pour ${preds.length} prédicteur(s) — la règle usuelle demande au moins ${10 * preds.length} événements.`);
  if (nPos / n < 0.1 || nPos / n > 0.9) rigueur.avertissements.push(`Classes déséquilibrées (${arrondi((nPos / n) * 100, 1)} % de positifs) : l'exactitude brute est trompeuse — juger sur l'AUC (${arrondi(auc, 3)}) et le rappel.`);
  if (auc > 0.99) rigueur.avertissements.push("AUC ≈ 1 : une séparation parfaite vient presque toujours d'un prédicteur qui contient déjà la réponse (fuite de données).");
  if (incompletes) rigueur.avertissements.push(`${incompletes} ligne(s) écartée(s) (cible non binaire ou valeur manquante).`);

  const predire = (x: Record<string, number>): number => {
    let z = beta[0]!;
    for (const [j, nom] of preds.entries()) z += beta[j + 1]! * (Number(x[nom]) || 0);
    return sigmoide(z);
  };

  return {
    ok: true, type: "logistique", cible, predicteurs: preds, n, positifs, coefficients, constante, pseudoR2, auc,
    exactitude: (vp + vn) / n, matriceConfusion: { vraisPositifs: vp, fauxPositifs: fp, vraisNegatifs: vn, fauxNegatifs: fn }, convergence,
    nettoyage: { observationsFournies: lignes.length, observationsUtilisees: n, lignesIncompletes: incompletes, colonnesConstantes: [], aberrantes: [] },
    predire, rigueur, ms: Date.now() - t0,
  };
}

/* ─────────────────────────────── Tests d'hypothèse ─────────────────────────────── */

export interface Test {
  nom: string;
  statistique: number;
  ddl: number | null;
  pValeur: number;
  significatif: boolean;
  /** La taille d'effet — ce qui dit si le résultat COMPTE, quand la p-value dit seulement s'il existe. */
  tailleEffet: { nom: string; valeur: number; interpretation: string } | null;
  intervalle95: [number, number] | null;
  conclusion: string;
  rigueur: Rigueur;
}

const interpreterCohen = (d: number): string => {
  const a = Math.abs(d);
  return a < 0.2 ? "négligeable" : a < 0.5 ? "petit" : a < 0.8 ? "moyen" : "grand";
};

/** Student sur deux échantillons INDÉPENDANTS (Welch : n'exige pas des variances égales). */
export function testMoyennes(a: readonly number[], b: readonly number[], alpha = 0.05): Test | { erreur: string } {
  const xa = a.filter(Number.isFinite), xb = b.filter(Number.isFinite);
  if (xa.length < 2 || xb.length < 2) return { erreur: "Au moins deux valeurs numériques par groupe sont nécessaires." };
  const ma = moyenne(xa), mb = moyenne(xb), va = variance(xa), vb = variance(xb), na = xa.length, nb = xb.length;
  const se = Math.sqrt(va / na + vb / nb);
  const rigueur = rigueurVide();
  if (se === 0) return { erreur: "Les deux groupes n'ont aucune variabilité : un test n'a pas de sens." };
  const t = (ma - mb) / se;
  const ddl = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  const pv = pValeurStudent(t, ddl);
  const sPooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  const d = sPooled > 0 ? (ma - mb) / sPooled : 0;
  const tc = quantileStudent(1 - alpha / 2, ddl);
  rigueur.hypotheses.push("Test de Welch : les deux groupes sont indépendants, les variances peuvent différer.");
  rigueur.limites.push("Une p-value dit si l'écart est distinguable du hasard, PAS s'il compte : lire la taille d'effet et l'intervalle.");
  if (Math.min(na, nb) < 15) rigueur.avertissements.push(`Petit échantillon (${Math.min(na, nb)} valeurs dans le plus petit groupe) : le test suppose une distribution proche de la normale, ce qui ne se vérifie pas ici.`);
  if (aberrantesDe(xa).length || aberrantesDe(xb).length) rigueur.avertissements.push("Valeurs aberrantes présentes : la moyenne y est sensible, comparer aussi les médianes (test de Mann-Whitney).");
  if (pv < alpha && Math.abs(d) < 0.2) rigueur.avertissements.push("Écart statistiquement significatif mais d'ampleur négligeable : sur un grand échantillon, tout devient significatif.");
  return {
    nom: "Comparaison de deux moyennes (Welch)", statistique: t, ddl, pValeur: pv, significatif: pv < alpha,
    tailleEffet: { nom: "d de Cohen", valeur: d, interpretation: interpreterCohen(d) },
    intervalle95: [(ma - mb) - tc * se, (ma - mb) + tc * se],
    conclusion: pv < alpha
      ? `Écart de ${arrondi(ma - mb, 4)} entre les deux moyennes, distinguable du hasard (p = ${arrondi(pv, 5)}) ; effet ${interpreterCohen(d)}.`
      : `Écart de ${arrondi(ma - mb, 4)}, NON distinguable du hasard (p = ${arrondi(pv, 4)}) : l'échantillon ne permet pas de conclure — ce n'est pas la preuve d'une absence d'écart.`,
    rigueur,
  };
}

/** Student APPARIÉ : les mêmes sujets avant/après. */
export function testApparie(avant: readonly number[], apres: readonly number[], alpha = 0.05): Test | { erreur: string } {
  if (avant.length !== apres.length) return { erreur: `Séries de tailles différentes (${avant.length} et ${apres.length}) : un test apparié compare les MÊMES sujets.` };
  const diff: number[] = [];
  for (let i = 0; i < avant.length; i += 1) if (Number.isFinite(avant[i]!) && Number.isFinite(apres[i]!)) diff.push(apres[i]! - avant[i]!);
  if (diff.length < 2) return { erreur: "Moins de deux paires complètes." };
  const md = moyenne(diff), sd = ecartType(diff), n = diff.length;
  if (sd === 0) return { erreur: "Toutes les différences sont identiques : un test n'a pas de sens." };
  const se = sd / Math.sqrt(n);
  const t = md / se, ddl = n - 1, pv = pValeurStudent(t, ddl), tc = quantileStudent(1 - alpha / 2, ddl);
  const rigueur = rigueurVide();
  rigueur.hypotheses.push("Test apparié : chaque valeur « après » correspond au même sujet que la valeur « avant ».");
  rigueur.limites.push("Un avant/après sans groupe témoin ne distingue pas l'effet de l'intervention de ce qui aurait changé de toute façon.");
  if (n < 15) rigueur.avertissements.push(`${n} paires : petit échantillon, la normalité des différences n'est pas vérifiable.`);
  const d = md / sd;
  return {
    nom: "Comparaison appariée (Student)", statistique: t, ddl, pValeur: pv, significatif: pv < alpha,
    tailleEffet: { nom: "d de Cohen", valeur: d, interpretation: interpreterCohen(d) },
    intervalle95: [md - tc * se, md + tc * se],
    conclusion: pv < alpha ? `Variation moyenne de ${arrondi(md, 4)} (p = ${arrondi(pv, 5)}), effet ${interpreterCohen(d)}.` : `Variation moyenne de ${arrondi(md, 4)} non distinguable du hasard (p = ${arrondi(pv, 4)}).`,
    rigueur,
  };
}

/** χ² d'indépendance sur un tableau de contingence. */
export function testIndependance(table: readonly (readonly number[])[], alpha = 0.05): Test | { erreur: string } {
  const l = table.length, c = table[0]?.length ?? 0;
  if (l < 2 || c < 2) return { erreur: "Un tableau de contingence d'au moins 2 lignes et 2 colonnes est nécessaire." };
  if (table.some((r) => r.length !== c)) return { erreur: "Toutes les lignes doivent avoir le même nombre de colonnes." };
  const total = table.reduce((s, r) => s + r.reduce((a, x) => a + x, 0), 0);
  if (total <= 0) return { erreur: "Tableau vide." };
  const sommesL = table.map((r) => r.reduce((a, x) => a + x, 0));
  const sommesC = Array.from({ length: c }, (_, j) => table.reduce((a, r) => a + r[j]!, 0));
  let khi = 0, faiblesEffectifs = 0;
  for (let i = 0; i < l; i += 1) for (let j = 0; j < c; j += 1) {
    const attendu = (sommesL[i]! * sommesC[j]!) / total;
    if (attendu < 5) faiblesEffectifs += 1;
    if (attendu > 0) khi += (table[i]![j]! - attendu) ** 2 / attendu;
  }
  const ddl = (l - 1) * (c - 1);
  const pv = pValeurKhiDeux(khi, ddl);
  const v = Math.sqrt(khi / (total * Math.min(l - 1, c - 1)));
  const rigueur = rigueurVide();
  rigueur.hypotheses.push("Observations indépendantes ; les effectifs sont des COMPTAGES, pas des pourcentages ni des moyennes.");
  rigueur.limites.push("Le test dit qu'il y a un lien, pas lequel ni dans quel sens : lire les écarts case par case.");
  if (faiblesEffectifs) rigueur.avertissements.push(`${faiblesEffectifs} case(s) d'effectif attendu < 5 : l'approximation du χ² est douteuse, regrouper des catégories.`);
  return {
    nom: "Indépendance (χ²)", statistique: khi, ddl, pValeur: pv, significatif: pv < alpha,
    tailleEffet: { nom: "V de Cramér", valeur: v, interpretation: v < 0.1 ? "négligeable" : v < 0.3 ? "faible" : v < 0.5 ? "moyen" : "fort" },
    intervalle95: null,
    conclusion: pv < alpha ? `Les deux variables ne sont pas indépendantes (p = ${arrondi(pv, 5)}), lien ${v < 0.3 ? "faible" : "marqué"} (V = ${arrondi(v, 3)}).` : `Aucun lien détectable (p = ${arrondi(pv, 4)}).`,
    rigueur,
  };
}

/** Mann-Whitney : compare deux distributions sans supposer la normalité. */
export function testRangs(a: readonly number[], b: readonly number[], alpha = 0.05): Test | { erreur: string } {
  const xa = a.filter(Number.isFinite), xb = b.filter(Number.isFinite);
  if (xa.length < 3 || xb.length < 3) return { erreur: "Au moins trois valeurs par groupe." };
  const tous = [...xa, ...xb];
  const rg = rangs(tous);
  const na = xa.length, nb = xb.length;
  let ra = 0;
  for (let i = 0; i < na; i += 1) ra += rg[i]!;
  const u1 = ra - (na * (na + 1)) / 2;
  const u = Math.min(u1, na * nb - u1);
  const mu = (na * nb) / 2;
  const sigma = Math.sqrt((na * nb * (na + nb + 1)) / 12);
  const z = sigma > 0 ? (u - mu) / sigma : 0;
  const pv = 2 * phi(-Math.abs(z));
  const rigueur = rigueurVide();
  rigueur.hypotheses.push("Test non paramétrique : aucune hypothèse de normalité, il compare les RANGS (donc les médianes plutôt que les moyennes).");
  rigueur.limites.push("Sur de petits échantillons, l'approximation normale utilisée ici est indicative.");
  const delta = (2 * u1) / (na * nb) - 1;
  return {
    nom: "Mann-Whitney (rangs)", statistique: u, ddl: null, pValeur: pv, significatif: pv < alpha,
    tailleEffet: { nom: "delta de Cliff", valeur: delta, interpretation: Math.abs(delta) < 0.15 ? "négligeable" : Math.abs(delta) < 0.33 ? "petit" : Math.abs(delta) < 0.47 ? "moyen" : "grand" },
    intervalle95: null,
    conclusion: pv < alpha ? `Les distributions diffèrent (médianes ${arrondi(mediane(xa), 4)} vs ${arrondi(mediane(xb), 4)}, p = ${arrondi(pv, 5)}).` : `Aucune différence détectable entre les distributions (p = ${arrondi(pv, 4)}).`,
    rigueur,
  };
}

/* ─────────────────────────────── Description et corrélations ─────────────────────────────── */

export interface Description {
  colonne: string;
  n: number;
  manquantes: number;
  moyenne: number;
  ecartType: number;
  min: number;
  q1: number;
  mediane: number;
  q3: number;
  max: number;
  asymetrie: number;
  aberrantes: number;
}

export function decrireColonnes(lignes: readonly Record<string, unknown>[], colonnes?: readonly string[]): Description[] {
  const noms = colonnes?.length ? colonnes : [...new Set(lignes.flatMap((l) => Object.keys(l)))];
  const out: Description[] = [];
  for (const c of noms) {
    const xs: number[] = [];
    let manquantes = 0;
    for (const l of lignes) { const v = nombreDe(l[c]); if (v === null) manquantes += 1; else xs.push(v); }
    if (xs.length < 2) continue;
    const m = moyenne(xs), s = ecartType(xs);
    const asym = s > 0 ? xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0) / xs.length : 0;
    out.push({
      colonne: c, n: xs.length, manquantes, moyenne: m, ecartType: s, min: Math.min(...xs), q1: percentile(xs, 25),
      mediane: mediane(xs), q3: percentile(xs, 75), max: Math.max(...xs), asymetrie: asym, aberrantes: aberrantesDe(xs).length,
    });
  }
  return out;
}

export interface Liaison { a: string; b: string; pearson: number; spearman: number; n: number; pValeur: number; significatif: boolean }

export function correlations(lignes: readonly Record<string, unknown>[], colonnes?: readonly string[], alpha = 0.05): { liaisons: Liaison[]; rigueur: Rigueur } {
  const noms = (colonnes?.length ? colonnes : [...new Set(lignes.flatMap((l) => Object.keys(l)))]).filter((c) => lignes.some((l) => nombreDe(l[c]) !== null));
  const liaisons: Liaison[] = [];
  for (let i = 0; i < noms.length; i += 1) for (let j = i + 1; j < noms.length; j += 1) {
    const xs: number[] = [], ys: number[] = [];
    for (const l of lignes) {
      const a = nombreDe(l[noms[i]!]), b = nombreDe(l[noms[j]!]);
      if (a !== null && b !== null) { xs.push(a); ys.push(b); }
    }
    if (xs.length < 4) continue;
    const r = pearson(xs, ys);
    const n = xs.length;
    const t = Math.abs(r) >= 1 ? Infinity : r * Math.sqrt((n - 2) / (1 - r * r));
    const pv = Number.isFinite(t) ? pValeurStudent(t, n - 2) : 0;
    liaisons.push({ a: noms[i]!, b: noms[j]!, pearson: r, spearman: spearman(xs, ys), n, pValeur: pv, significatif: pv < alpha });
  }
  liaisons.sort((x, y) => Math.abs(y.pearson) - Math.abs(x.pearson));
  const rigueur = rigueurVide();
  rigueur.limites.push("Une corrélation n'est pas une cause : elle peut venir d'une troisième variable, d'une sélection de l'échantillon, ou du hasard.");
  const paires = liaisons.length;
  if (paires > 10) rigueur.avertissements.push(`${paires} paires testées : à 5 %, ${Math.round(paires * 0.05)} corrélation(s) « significative(s) » sont attendues par pur hasard — ne pas retenir une liaison sur sa seule p-value.`);
  const divergentes = liaisons.filter((l) => Math.abs(l.pearson - l.spearman) > 0.25);
  if (divergentes.length) rigueur.avertissements.push(`Pearson et Spearman divergent sur ${divergentes.map((l) => `${l.a}↔${l.b}`).join(", ")} : la relation n'est pas linéaire ou des valeurs extrêmes la déforment.`);
  return { liaisons, rigueur };
}
