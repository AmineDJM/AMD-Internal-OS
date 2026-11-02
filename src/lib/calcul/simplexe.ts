/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OPTIMISATION SOUS CONTRAINTES (mandat 5 §39) — pur.
 *
 * Programmation linéaire par le SIMPLEXE en deux phases (forme standard, règle de Bland contre le
 * cyclage), et programmation linéaire en nombres ENTIERS par SÉPARATION ET ÉVALUATION (branch &
 * bound) sur les variables déclarées entières ou binaires.
 *
 * Ce qu'un optimum vaut sans son contexte : rien. Le résultat porte donc les VARIABLES DUALES
 * (le prix marginal d'une contrainte : « une heure de plus sur la ligne A rapporte 12 000 DZD »),
 * les contraintes SATURÉES, le JEU (slack) de chacune, et la mention explicite quand la solution
 * entière a été obtenue par arrondi de la relaxation — un écart d'optimalité chiffré, jamais
 * présenté comme l'optimum exact.
 *
 * INFAISABLE et NON BORNÉ ne sont pas des erreurs techniques : ce sont des RÉPONSES, et elles
 * disent laquelle des contraintes est en cause quand le code peut le déterminer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { type Rigueur, arrondi, rigueurVide } from "./rigueur";

export type Sens = "max" | "min";
export type Comparateur = "<=" | ">=" | "=";

export interface Variable {
  nom: string;
  /** Coefficient dans l'objectif. */
  objectif?: number;
  min?: number;
  max?: number;
  type?: "continue" | "entiere" | "binaire";
}

export interface Contrainte {
  nom?: string;
  /** Coefficients par nom de variable ; une variable absente vaut 0. */
  coefficients: Record<string, number>;
  comparateur: Comparateur;
  valeur: number;
}

export interface Programme {
  sens: Sens;
  variables: Variable[];
  contraintes: Contrainte[];
}

export interface OptionsOptimisation {
  /** Nombre maximal de nœuds explorés en séparation et évaluation (limite opérationnelle). */
  noeudsMax?: number;
  /** Écart relatif accepté pour arrêter la recherche entière (0,0001 = 0,01 %). */
  tolerance?: number;
  msMax?: number;
}

export interface ContrainteResolue {
  nom: string;
  comparateur: Comparateur;
  valeur: number;
  /** La valeur atteinte par la partie gauche à l'optimum. */
  atteinte: number;
  jeu: number;
  saturee: boolean;
  /** Le prix marginal (dual) : de combien l'objectif bouge si le second membre augmente d'une unité. */
  prixMarginal: number | null;
}

export interface Optimum {
  ok: true;
  statut: "OPTIMAL" | "OPTIMAL_ENTIER" | "REALISABLE";
  sens: Sens;
  objectif: number;
  valeurs: Record<string, number>;
  contraintes: ContrainteResolue[];
  /** Les contraintes qui bloquent : celles dont le prix marginal n'est pas nul. */
  goulots: { nom: string; prixMarginal: number; interpretation: string }[];
  entier: boolean;
  /** Pour un programme entier : l'écart entre la meilleure solution entière et la borne de la relaxation. */
  ecartOptimalite: number | null;
  noeuds: number;
  iterations: number;
  rigueur: Rigueur;
  ms: number;
}

export type ResultatOptimisation =
  | Optimum
  | { ok: false; statut: "INFAISABLE" | "NON_BORNE" | "INVALIDE" | "LIMITE"; erreur: string; details?: string[]; rigueur?: Rigueur };

export const NOEUDS_MAX = 20_000;
export const VARIABLES_MAX = 500;
export const CONTRAINTES_MAX = 500;

interface Standard {
  /** Matrice A (m × n) augmentée des variables d'écart et artificielles. */
  A: Float64Array[];
  b: Float64Array;
  c: Float64Array;
  n: number;
  m: number;
  /** Indices des colonnes artificielles. */
  artificielles: number[];
  base: number[];
}

/** Le simplexe primal (phase donnée par le vecteur de coût), règle de Bland pour ne jamais cycler. */
function simplexe(s: Standard, cout: Float64Array, iterationsMax: number): { statut: "OPTIMAL" | "NON_BORNE" | "LIMITE"; iterations: number } {
  const { A, b, base, m, n } = s;
  let iterations = 0;
  for (;;) {
    if (iterations >= iterationsMax) return { statut: "LIMITE", iterations };
    iterations += 1;
    // Coûts réduits : z_j - c_j pour un problème de MINIMISATION.
    const y = new Float64Array(m);
    for (let i = 0; i < m; i += 1) y[i] = cout[base[i]!]!;
    let entrante = -1;
    for (let j = 0; j < n; j += 1) {
      let zj = 0;
      for (let i = 0; i < m; i += 1) zj += y[i]! * A[i]![j]!;
      const reduit = cout[j]! - zj;
      if (reduit < -1e-9) { entrante = j; break; } // Bland : le PREMIER indice éligible.
    }
    if (entrante < 0) return { statut: "OPTIMAL", iterations };
    // Test du rapport minimal, départages par le plus petit indice de base (Bland).
    let sortante = -1, meilleur = Infinity;
    for (let i = 0; i < m; i += 1) {
      const a = A[i]![entrante]!;
      if (a > 1e-9) {
        const r = b[i]! / a;
        if (r < meilleur - 1e-12 || (Math.abs(r - meilleur) <= 1e-12 && (sortante < 0 || base[i]! < base[sortante]!))) { meilleur = r; sortante = i; }
      }
    }
    if (sortante < 0) return { statut: "NON_BORNE", iterations };
    // Pivot.
    const p = A[sortante]!, pivot = p[entrante]!;
    for (let j = 0; j < n; j += 1) p[j] = p[j]! / pivot;
    b[sortante] = b[sortante]! / pivot;
    for (let i = 0; i < m; i += 1) {
      if (i === sortante) continue;
      const f = A[i]![entrante]!;
      if (Math.abs(f) < 1e-14) continue;
      const li = A[i]!;
      for (let j = 0; j < n; j += 1) li[j] = li[j]! - f * p[j]!;
      b[i] = b[i]! - f * b[sortante]!;
    }
    base[sortante] = entrante;
  }
}

interface Modele {
  noms: string[];
  bornesMin: number[];
  bornesMax: (number | null)[];
  objectif: number[];
  contraintes: { nom: string; coef: number[]; comparateur: Comparateur; valeur: number }[];
  sens: Sens;
}

/**
 * Résout la RELAXATION continue. Chaque variable est translatée par sa borne inférieure (x = min + x'),
 * chaque borne supérieure devient une contrainte — c'est ce qui rend les duales lisibles.
 */
function resoudreRelaxation(mod: Modele, iterationsMax: number): { statut: "OPTIMAL" | "INFAISABLE" | "NON_BORNE" | "LIMITE"; x: number[]; objectif: number; duales: number[]; iterations: number } {
  const nv = mod.noms.length;
  const lignes: { coef: number[]; comparateur: Comparateur; valeur: number }[] = [];
  for (const c of mod.contraintes) {
    let v = c.valeur;
    for (let j = 0; j < nv; j += 1) v -= c.coef[j]! * mod.bornesMin[j]!;
    lignes.push({ coef: [...c.coef], comparateur: c.comparateur, valeur: v });
  }
  const nContraintesReelles = lignes.length;
  for (let j = 0; j < nv; j += 1) {
    const hi = mod.bornesMax[j];
    if (hi !== null && hi !== undefined && Number.isFinite(hi)) {
      const coef = new Array<number>(nv).fill(0);
      coef[j] = 1;
      lignes.push({ coef, comparateur: "<=", valeur: hi - mod.bornesMin[j]! });
    }
  }
  const m = lignes.length;
  // Normaliser : second membre ≥ 0.
  for (const l of lignes) {
    if (l.valeur < 0) {
      l.valeur = -l.valeur;
      l.coef = l.coef.map((x) => -x);
      l.comparateur = l.comparateur === "<=" ? ">=" : l.comparateur === ">=" ? "<=" : "=";
    }
  }
  const ecarts = lignes.filter((l) => l.comparateur !== "=").length;
  const artificiellesNb = lignes.filter((l) => l.comparateur !== "<=").length;
  const n = nv + ecarts + artificiellesNb;
  const A: Float64Array[] = Array.from({ length: m }, () => new Float64Array(n));
  const b = new Float64Array(m);
  const base = new Array<number>(m).fill(-1);
  const artificielles: number[] = [];
  let colEcart = nv, colArt = nv + ecarts;
  for (let i = 0; i < m; i += 1) {
    const l = lignes[i]!;
    for (let j = 0; j < nv; j += 1) A[i]![j] = l.coef[j]!;
    b[i] = l.valeur;
    if (l.comparateur === "<=") { A[i]![colEcart] = 1; base[i] = colEcart; colEcart += 1; }
    else if (l.comparateur === ">=") { A[i]![colEcart] = -1; colEcart += 1; A[i]![colArt] = 1; base[i] = colArt; artificielles.push(colArt); colArt += 1; }
    else { A[i]![colArt] = 1; base[i] = colArt; artificielles.push(colArt); colArt += 1; }
  }
  const s: Standard = { A, b, c: new Float64Array(n), n, m, artificielles, base };

  // Phase 1 : minimiser la somme des artificielles.
  let iterations = 0;
  if (artificielles.length) {
    const cout1 = new Float64Array(n);
    for (const a of artificielles) cout1[a] = 1;
    const r1 = simplexe(s, cout1, iterationsMax);
    iterations += r1.iterations;
    if (r1.statut === "LIMITE") return { statut: "LIMITE", x: [], objectif: NaN, duales: [], iterations };
    let somme = 0;
    for (let i = 0; i < m; i += 1) if (artificielles.includes(base[i]!)) somme += b[i]!;
    if (somme > 1e-7) return { statut: "INFAISABLE", x: [], objectif: NaN, duales: [], iterations };
    // Chasser les artificielles restées en base (à valeur nulle).
    for (let i = 0; i < m; i += 1) {
      if (!artificielles.includes(base[i]!)) continue;
      let remplacant = -1;
      for (let j = 0; j < nv + ecarts; j += 1) if (Math.abs(A[i]![j]!) > 1e-9) { remplacant = j; break; }
      if (remplacant < 0) continue;
      const p = A[i]!, pivot = p[remplacant]!;
      for (let j = 0; j < n; j += 1) p[j] = p[j]! / pivot;
      b[i] = b[i]! / pivot;
      for (let k = 0; k < m; k += 1) {
        if (k === i) continue;
        const f = A[k]![remplacant]!;
        if (Math.abs(f) < 1e-14) continue;
        const lk = A[k]!;
        for (let j = 0; j < n; j += 1) lk[j] = lk[j]! - f * p[j]!;
        b[k] = b[k]! - f * b[i]!;
      }
      base[i] = remplacant;
    }
  }

  // Phase 2 : l'objectif réel, toujours en MINIMISATION (max f = min −f). Les artificielles sont interdites.
  const signe = mod.sens === "max" ? -1 : 1;
  const cout2 = new Float64Array(n);
  for (let j = 0; j < nv; j += 1) cout2[j] = signe * mod.objectif[j]!;
  for (const a of artificielles) cout2[a] = 1e12;
  const r2 = simplexe(s, cout2, iterationsMax);
  iterations += r2.iterations;
  if (r2.statut === "NON_BORNE") return { statut: "NON_BORNE", x: [], objectif: NaN, duales: [], iterations };
  if (r2.statut === "LIMITE") return { statut: "LIMITE", x: [], objectif: NaN, duales: [], iterations };

  const x = new Array<number>(nv).fill(0);
  for (let i = 0; i < m; i += 1) if (base[i]! < nv) x[base[i]!] = b[i]!;
  for (let j = 0; j < nv; j += 1) x[j] = x[j]! + mod.bornesMin[j]!;
  let objectif = 0;
  for (let j = 0; j < nv; j += 1) objectif += mod.objectif[j]! * x[j]!;

  // Les duales : y = c_B B⁻¹. La base finale les porte via les coûts réduits des colonnes d'écart.
  const y = new Float64Array(m);
  for (let i = 0; i < m; i += 1) y[i] = cout2[base[i]!]!;
  const duales: number[] = [];
  colEcart = nv;
  for (let i = 0; i < nContraintesReelles; i += 1) {
    const l = lignes[i]!;
    if (l.comparateur === "=") { duales.push(0); continue; }
    // Le coût réduit de la colonne d'écart de la contrainte i vaut ± la duale.
    const col = colEcart;
    let zj = 0;
    for (let k = 0; k < m; k += 1) zj += y[k]! * A[k]![col]!;
    colEcart += 1;
    const dual = l.comparateur === "<=" ? zj : -zj;
    duales.push(signe * dual);
  }
  // Les contraintes retournées (second membre négatif) ont vu leur signe changer : le dual suit.
  for (let i = 0; i < nContraintesReelles; i += 1) if (mod.contraintes[i]!.valeur < 0 && lignes[i]!.valeur >= 0) duales[i] = -duales[i]!;
  return { statut: "OPTIMAL", x, objectif, duales, iterations };
}

function validerProgramme(p: Programme): string[] {
  const e: string[] = [];
  if (p.sens !== "max" && p.sens !== "min") e.push("Sens : « max » ou « min » attendu.");
  const vars = p.variables ?? [];
  if (!vars.length) e.push("Aucune variable de décision.");
  if (vars.length > VARIABLES_MAX) e.push(`${vars.length} variables : ${VARIABLES_MAX} au plus (limite opérationnelle du solveur).`);
  const noms = new Set<string>();
  for (const v of vars) {
    if (!v?.nom) { e.push("Variable sans nom."); continue; }
    if (noms.has(v.nom)) e.push(`Variable « ${v.nom} » déclarée deux fois.`);
    noms.add(v.nom);
    const lo = v.min ?? 0, hi = v.max;
    if (!Number.isFinite(lo)) e.push(`Variable « ${v.nom} » : borne inférieure non finie.`);
    if (hi !== undefined && hi !== null && Number.isFinite(hi) && hi < lo) e.push(`Variable « ${v.nom} » : max (${hi}) inférieur à min (${lo}).`);
    if (v.type && !["continue", "entiere", "binaire"].includes(v.type)) e.push(`Variable « ${v.nom} » : type inconnu « ${v.type} ».`);
    if (v.objectif !== undefined && !Number.isFinite(v.objectif)) e.push(`Variable « ${v.nom} » : coefficient d'objectif non fini.`);
  }
  const contraintes = p.contraintes ?? [];
  if (contraintes.length > CONTRAINTES_MAX) e.push(`${contraintes.length} contraintes : ${CONTRAINTES_MAX} au plus.`);
  for (const [i, c] of contraintes.entries()) {
    const etiquette = c?.nom ?? `contrainte ${i + 1}`;
    if (!c?.coefficients || !Object.keys(c.coefficients).length) { e.push(`${etiquette} : aucun coefficient.`); continue; }
    for (const k of Object.keys(c.coefficients)) if (!noms.has(k)) e.push(`${etiquette} : « ${k} » n'est pas une variable déclarée.`);
    if (!["<=", ">=", "="].includes(c.comparateur)) e.push(`${etiquette} : comparateur « ${c.comparateur} » inconnu (<=, >=, =).`);
    if (!Number.isFinite(c.valeur)) e.push(`${etiquette} : second membre non fini.`);
  }
  if (vars.every((v) => !v.objectif)) e.push("Objectif nul : aucune variable ne porte de coefficient — dire ce qu'on maximise ou minimise.");
  return e;
}

/** Résout un programme linéaire, entier ou mixte. Le résultat porte l'optimum ET ce qui le contraint. */
export function optimiser(p: Programme, options: OptionsOptimisation = {}): ResultatOptimisation {
  const t0 = Date.now();
  const erreurs = validerProgramme(p);
  if (erreurs.length) return { ok: false, statut: "INVALIDE", erreur: erreurs[0]!, details: erreurs };
  const rigueur = rigueurVide();
  const noms = p.variables.map((v) => v.nom);
  const types = p.variables.map((v) => v.type ?? "continue");
  const mod: Modele = {
    noms,
    bornesMin: p.variables.map((v, i) => (types[i] === "binaire" ? Math.max(0, v.min ?? 0) : v.min ?? 0)),
    bornesMax: p.variables.map((v, i) => (types[i] === "binaire" ? Math.min(1, v.max ?? 1) : v.max ?? null)),
    objectif: p.variables.map((v) => v.objectif ?? 0),
    contraintes: p.contraintes.map((c, i) => ({ nom: c.nom ?? `contrainte ${i + 1}`, coef: noms.map((n) => c.coefficients[n] ?? 0), comparateur: c.comparateur, valeur: c.valeur })),
    sens: p.sens,
  };
  const iterationsMax = Math.max(2_000, 40 * (mod.noms.length + mod.contraintes.length));
  const noeudsMax = Math.max(1, Math.min(NOEUDS_MAX, options.noeudsMax ?? 5_000));
  const tolerance = options.tolerance ?? 1e-6;
  const msMax = options.msMax ?? 8_000;

  const racine = resoudreRelaxation(mod, iterationsMax);
  let iterations = racine.iterations;
  if (racine.statut === "INFAISABLE") {
    return { ok: false, statut: "INFAISABLE", erreur: "Aucune solution ne satisfait toutes les contraintes en même temps : elles se contredisent. Relâcher une capacité, un minimum ou une égalité.", rigueur };
  }
  if (racine.statut === "NON_BORNE") {
    return { ok: false, statut: "NON_BORNE", erreur: `L'objectif peut croître sans limite : il manque une contrainte de capacité ou une borne supérieure sur ${mod.noms.filter((_, j) => mod.bornesMax[j] === null).join(", ") || "les variables"}.`, rigueur };
  }
  if (racine.statut === "LIMITE") return { ok: false, statut: "LIMITE", erreur: "Le solveur a atteint sa limite d'itérations sans conclure : simplifier le modèle (moins de variables ou de contraintes).", rigueur };

  const entieres = types.map((t, i) => (t === "entiere" || t === "binaire" ? i : -1)).filter((i) => i >= 0);
  let meilleurX = racine.x, meilleurObj = racine.objectif, meilleuresDuales = racine.duales;
  let noeuds = 1;
  let borne = racine.objectif;
  let ecartOptimalite: number | null = null;
  let entierResolu = false;

  if (entieres.length) {
    const estEntier = (x: number[]) => entieres.every((j) => Math.abs(x[j]! - Math.round(x[j]!)) < 1e-6);
    if (estEntier(racine.x)) {
      entierResolu = true;
      ecartOptimalite = 0;
      meilleurX = racine.x.map((v, j) => (entieres.includes(j) ? Math.round(v) : v));
    } else {
      // Séparation et évaluation : pile de sous-problèmes (bornes resserrées sur une variable fractionnaire).
      const pire = p.sens === "max" ? -Infinity : Infinity;
      let incumbent: { x: number[]; obj: number; duales: number[] } | null = null;
      const meilleurQue = (a: number, b: number) => (p.sens === "max" ? a > b : a < b);
      type Noeud = { min: number[]; max: (number | null)[]; borne: number };
      const pile: Noeud[] = [{ min: [...mod.bornesMin], max: [...mod.bornesMax], borne: racine.objectif }];
      let borneMeilleure = racine.objectif;
      while (pile.length) {
        if (noeuds >= noeudsMax || Date.now() - t0 > msMax) {
          rigueur.limites.push(`Recherche entière arrêtée après ${noeuds} nœuds (limite opérationnelle) : la solution rendue est la meilleure TROUVÉE, pas nécessairement l'optimum.`);
          break;
        }
        // Meilleure borne d'abord : on explore le nœud le plus prometteur.
        pile.sort((a, b) => (p.sens === "max" ? b.borne - a.borne : a.borne - b.borne));
        const n = pile.shift()!;
        if (incumbent && !meilleurQue(n.borne, incumbent.obj + (p.sens === "max" ? -1 : 1) * tolerance * Math.max(1, Math.abs(incumbent.obj)))) continue;
        const sous = resoudreRelaxation({ ...mod, bornesMin: n.min, bornesMax: n.max }, iterationsMax);
        noeuds += 1;
        iterations += sous.iterations;
        if (sous.statut !== "OPTIMAL") continue;
        if (incumbent && !meilleurQue(sous.objectif, incumbent.obj)) continue;
        if (estEntier(sous.x)) {
          incumbent = { x: sous.x.map((v, j) => (entieres.includes(j) ? Math.round(v) : v)), obj: sous.objectif, duales: sous.duales };
          continue;
        }
        const j = entieres.find((k) => Math.abs(sous.x[k]! - Math.round(sous.x[k]!)) >= 1e-6)!;
        const v = sous.x[j]!;
        const bas = { min: [...n.min], max: [...n.max], borne: sous.objectif };
        bas.max[j] = Math.floor(v);
        const haut = { min: [...n.min], max: [...n.max], borne: sous.objectif };
        haut.min[j] = Math.ceil(v);
        if (bas.max[j]! >= bas.min[j]!) pile.push(bas);
        if (haut.max[j] === null || haut.max[j]! >= haut.min[j]!) pile.push(haut);
        borneMeilleure = pile.length ? pile.reduce((best, x) => (meilleurQue(x.borne, best) ? x.borne : best), pire) : sous.objectif;
      }
      if (!incumbent) {
        return { ok: false, statut: "INFAISABLE", erreur: "Aucune solution ENTIÈRE ne satisfait les contraintes (la version continue en a une) : les quantités indivisibles rendent le problème infaisable.", rigueur };
      }
      meilleurX = incumbent.x; meilleurObj = incumbent.obj; meilleuresDuales = incumbent.duales;
      entierResolu = true;
      borne = pile.length ? borneMeilleure : incumbent.obj;
      ecartOptimalite = Math.abs(borne - incumbent.obj) / Math.max(1, Math.abs(incumbent.obj));
      if (ecartOptimalite < 1e-9) ecartOptimalite = 0;
    }
  }

  // Les contraintes à l'optimum.
  const contraintes: ContrainteResolue[] = mod.contraintes.map((c, i) => {
    let atteinte = 0;
    for (let j = 0; j < meilleurX.length; j += 1) atteinte += c.coef[j]! * meilleurX[j]!;
    const jeu = c.comparateur === "<=" ? c.valeur - atteinte : c.comparateur === ">=" ? atteinte - c.valeur : Math.abs(atteinte - c.valeur);
    const dual = entierResolu ? null : meilleuresDuales[i] ?? null;
    return { nom: c.nom, comparateur: c.comparateur, valeur: c.valeur, atteinte, jeu, saturee: Math.abs(jeu) < 1e-6, prixMarginal: dual === null ? null : Math.abs(dual) < 1e-9 ? 0 : dual };
  });
  const goulots = contraintes
    .filter((c) => c.prixMarginal !== null && Math.abs(c.prixMarginal) > 1e-7)
    .sort((a, b) => Math.abs(b.prixMarginal!) - Math.abs(a.prixMarginal!))
    .map((c) => ({
      nom: c.nom,
      prixMarginal: c.prixMarginal!,
      interpretation: `une unité de plus sur « ${c.nom} » ${c.prixMarginal! > 0 ? "améliore" : "dégrade"} l'objectif de ${arrondi(Math.abs(c.prixMarginal!), 4)}`,
    }));

  if (entierResolu) {
    rigueur.hypotheses.push(`Variables indivisibles : ${entieres.map((j) => noms[j]).join(", ")} — résolues par séparation et évaluation, pas par arrondi de la solution continue.`);
    rigueur.limites.push("Avec des variables entières, les prix marginaux (duales) n'existent pas : ils ne sont donnés que pour la relaxation continue.");
    if (ecartOptimalite && ecartOptimalite > tolerance) rigueur.avertissements.push(`Écart d'optimalité ${arrondi(ecartOptimalite * 100, 3)} % : l'optimum exact est au plus meilleur de cela.`);
  } else {
    rigueur.hypotheses.push("Variables continues et relations linéaires : un coût unitaire constant, pas de remise par palier ni de rendement d'échelle.");
    rigueur.limites.push("Les prix marginaux ne valent que LOCALEMENT : au-delà d'un certain changement du second membre, la base optimale change et le prix aussi.");
  }
  if (!contraintes.some((c) => c.saturee)) rigueur.avertissements.push("Aucune contrainte n'est saturée à l'optimum : le résultat est porté par les bornes des variables, pas par les capacités déclarées.");
  const degenere = contraintes.filter((c) => c.saturee).length > mod.noms.length;
  if (degenere) rigueur.avertissements.push("Solution dégénérée (plus de contraintes saturées que de variables) : plusieurs jeux de prix marginaux sont valides, ceux-ci en sont un.");

  return {
    ok: true,
    statut: entierResolu ? "OPTIMAL_ENTIER" : "OPTIMAL",
    sens: p.sens,
    objectif: meilleurObj,
    valeurs: Object.fromEntries(noms.map((n, j) => [n, Math.abs(meilleurX[j]!) < 1e-9 ? 0 : meilleurX[j]!])),
    contraintes,
    goulots,
    entier: entierResolu,
    ecartOptimalite,
    noeuds,
    iterations,
    rigueur,
    ms: Date.now() - t0,
  };
}

/** Le texte court : l'optimum, ce qui le bloque, ce qui reste libre. */
export function resumerOptimum(r: Optimum): string[] {
  const lignes = [`Objectif ${r.sens === "max" ? "maximal" : "minimal"} : ${arrondi(r.objectif, 4)}${r.entier ? " (solution entière)" : ""}.`];
  const actives = Object.entries(r.valeurs).filter(([, v]) => Math.abs(v) > 1e-9);
  lignes.push(`Décisions : ${actives.length ? actives.map(([n, v]) => `${n} = ${arrondi(v, 4)}`).join(", ") : "toutes nulles"}.`);
  if (r.goulots.length) lignes.push(`Ce qui bloque : ${r.goulots.slice(0, 3).map((g) => g.interpretation).join(" ; ")}.`);
  const libres = r.contraintes.filter((c) => !c.saturee && c.comparateur !== "=");
  if (libres.length) lignes.push(`Marge restante : ${libres.slice(0, 3).map((c) => `${c.nom} (${arrondi(c.jeu, 4)})`).join(", ")}.`);
  return lignes;
}
