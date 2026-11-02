/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANALYSE DE DONNÉES — les opérations que le code sait faire EXACTEMENT (mandat 4 §25).
 *
 * Un modèle qui additionne se trompe ; un modèle qui décrit une somme faite par le code ne se
 * trompe pas. Ce module est le calculateur : regroupements, agrégats, tableaux croisés, séries
 * (rééchantillonnage mensuel, moyenne mobile, croissance), fenêtres (rang, cumul), cohortes,
 * anomalies (z-score robuste), percentiles, tendance linéaire, scénarios. Pur, sans I/O, testé
 * sur des valeurs connues — c'est lui qui tourne dans le bac à sable et derrière `run_analysis`.
 *
 * Toute opération dit ce qu'elle a IGNORÉ (valeurs non numériques, dates illisibles) : un total
 * qui a sauté trois lignes sans le dire est un total faux.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Ligne = Record<string, unknown>;
export type Agregat = "count" | "sum" | "avg" | "min" | "max" | "median" | "p90" | "distinct";

export interface Ignore { colonne: string; ignorees: number; raison: string }

const SEPARATEUR = "\u001f";

const nombre = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "toNumber" in v && typeof (v as { toNumber: () => number }).toNumber === "function") return (v as { toNumber: () => number }).toNumber();
  if (typeof v === "string") {
    const s = v.replace(/[\s\u00a0\u202f]/g, "").replace(/DZD|EUR|USD|€|\$/gi, "").replace(",", ".");
    if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  return null;
};

const date = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (iso) { const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`); return Number.isNaN(d.getTime()) ? null : d; }
    const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
    if (fr) { const d = new Date(Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]))); return Number.isNaN(d.getTime()) ? null : d; }
  }
  return null;
};

export { nombre as versNombre, date as versDate };

export function mediane(v: readonly number[]): number | null {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(v: readonly number[], p: number): number | null {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function agreger(valeurs: readonly unknown[], agregat: Agregat): { valeur: number | null; ignorees: number } {
  if (agregat === "count") return { valeur: valeurs.length, ignorees: 0 };
  if (agregat === "distinct") return { valeur: new Set(valeurs.map((x) => String(x))).size, ignorees: 0 };
  const nums = valeurs.map(nombre).filter((n): n is number => n !== null);
  const ignorees = valeurs.length - nums.length;
  if (!nums.length) return { valeur: null, ignorees };
  switch (agregat) {
    case "sum": return { valeur: nums.reduce((a, b) => a + b, 0), ignorees };
    case "avg": return { valeur: nums.reduce((a, b) => a + b, 0) / nums.length, ignorees };
    case "min": return { valeur: Math.min(...nums), ignorees };
    case "max": return { valeur: Math.max(...nums), ignorees };
    case "median": return { valeur: mediane(nums), ignorees };
    case "p90": return { valeur: percentile(nums, 90), ignorees };
  }
}

// ─────────────────────────────── Décrire ───────────────────────────────

export interface Colonne { nom: string; type: "nombre" | "date" | "texte" | "booleen" | "vide"; remplis: number; distincts: number; min?: number | string | null; max?: number | string | null; somme?: number | null; moyenne?: number | null; mediane?: number | null }

/** Le PROFIL d'un jeu de lignes : type dominant par colonne, remplissage, bornes — ce qu'on regarde avant tout calcul. */
export function decrire(lignes: readonly Ligne[]): { lignes: number; colonnes: Colonne[] } {
  const noms = [...new Set(lignes.flatMap((l) => Object.keys(l)))];
  const colonnes = noms.map((nom): Colonne => {
    const vals = lignes.map((l) => l[nom]).filter((v) => v !== null && v !== undefined && v !== "");
    const nums = vals.map(nombre).filter((n): n is number => n !== null);
    const dates = vals.map(date).filter((d): d is Date => d !== null);
    const bools = vals.filter((v) => typeof v === "boolean");
    const type: Colonne["type"] = !vals.length ? "vide" : bools.length === vals.length ? "booleen" : nums.length >= vals.length * 0.8 ? "nombre" : dates.length >= vals.length * 0.8 ? "date" : "texte";
    const c: Colonne = { nom, type, remplis: vals.length, distincts: new Set(vals.map((v) => String(v))).size };
    if (type === "nombre") { c.min = Math.min(...nums); c.max = Math.max(...nums); c.somme = nums.reduce((a, b) => a + b, 0); c.moyenne = c.somme / nums.length; c.mediane = mediane(nums); }
    if (type === "date") { const t = dates.map((d) => d.getTime()); c.min = new Date(Math.min(...t)).toISOString().slice(0, 10); c.max = new Date(Math.max(...t)).toISOString().slice(0, 10); }
    return c;
  });
  return { lignes: lignes.length, colonnes };
}

// ─────────────────────────────── Regrouper, croiser, filtrer ───────────────────────────────

export interface Mesure { colonne: string; agregat: Agregat; alias?: string }

export function regrouper(lignes: readonly Ligne[], par: readonly string[], mesures: readonly Mesure[]): { lignes: Ligne[]; ignores: Ignore[] } {
  const groupes = new Map<string, Ligne[]>();
  for (const l of lignes) {
    const k = par.map((c) => String(l[c] ?? "")).join(SEPARATEUR);
    const g = groupes.get(k);
    if (g) g.push(l); else groupes.set(k, [l]);
  }
  const ignores = new Map<string, number>();
  const out: Ligne[] = [];
  for (const [, g] of groupes) {
    const ligne: Ligne = {};
    for (const c of par) ligne[c] = g[0][c] ?? null;
    for (const m of mesures) {
      const r = agreger(g.map((x) => x[m.colonne]), m.agregat);
      ligne[m.alias ?? `${m.agregat}_${m.colonne}`] = r.valeur;
      if (r.ignorees) ignores.set(m.colonne, (ignores.get(m.colonne) ?? 0) + r.ignorees);
    }
    out.push(ligne);
  }
  return { lignes: out, ignores: [...ignores].map(([colonne, ignorees]) => ({ colonne, ignorees, raison: "valeur non numérique" })) };
}

export function croiser(lignes: readonly Ligne[], ligne: string, colonne: string, mesure: Mesure): { lignes: Ligne[]; colonnes: string[] } {
  const colonnes = [...new Set(lignes.map((l) => String(l[colonne] ?? "")))].sort();
  const parLigne = new Map<string, Ligne[]>();
  for (const l of lignes) { const k = String(l[ligne] ?? ""); const g = parLigne.get(k); if (g) g.push(l); else parLigne.set(k, [l]); }
  const out: Ligne[] = [];
  for (const [k, g] of parLigne) {
    const r: Ligne = { [ligne]: k };
    for (const c of colonnes) r[c] = agreger(g.filter((x) => String(x[colonne] ?? "") === c).map((x) => x[mesure.colonne]), mesure.agregat).valeur;
    out.push(r);
  }
  return { lignes: out, colonnes };
}

export type Operateur = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contient" | "vide" | "non_vide" | "dans";
export interface Filtre { colonne: string; op: Operateur; valeur?: unknown }

export function filtrer(lignes: readonly Ligne[], filtres: readonly Filtre[]): Ligne[] {
  return lignes.filter((l) => filtres.every((f) => {
    const v = l[f.colonne];
    switch (f.op) {
      case "vide": return v === null || v === undefined || v === "";
      case "non_vide": return !(v === null || v === undefined || v === "");
      case "contient": return String(v ?? "").toLowerCase().includes(String(f.valeur ?? "").toLowerCase());
      case "dans": return Array.isArray(f.valeur) && f.valeur.map(String).includes(String(v));
      case "=": return String(v) === String(f.valeur) || (nombre(v) !== null && nombre(v) === nombre(f.valeur));
      case "!=": return !(String(v) === String(f.valeur) || (nombre(v) !== null && nombre(v) === nombre(f.valeur)));
      default: {
        const a = nombre(v) ?? date(v)?.getTime() ?? null; const b = nombre(f.valeur) ?? date(f.valeur)?.getTime() ?? null;
        if (a === null || b === null) return false;
        return f.op === ">" ? a > b : f.op === ">=" ? a >= b : f.op === "<" ? a < b : a <= b;
      }
    }
  }));
}

/**
 * TRIER : numérique (ou par date) dès qu'une valeur de la colonne se lit ainsi ; sinon par texte.
 * Une valeur ILLISIBLE dans une colonne numérique (« n/a », vide) va TOUJOURS en dernier, quel
 * que soit le sens — sinon « n/a » passerait devant le plus grand montant en tri décroissant.
 */
export function trier(lignes: readonly Ligne[], colonne: string, sens: "asc" | "desc" = "desc"): Ligne[] {
  const cle = (l: Ligne): number | null => nombre(l[colonne]) ?? date(l[colonne])?.getTime() ?? null;
  const numerique = lignes.some((l) => cle(l) !== null);
  return [...lignes].sort((x, y) => {
    if (numerique) {
      const a = cle(x); const b = cle(y);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return sens === "asc" ? a - b : b - a;
    }
    const c = String(x[colonne] ?? "").localeCompare(String(y[colonne] ?? ""));
    return sens === "asc" ? c : -c;
  });
}

// ─────────────────────────────── Séries temporelles ───────────────────────────────

export type Pas = "jour" | "semaine" | "mois" | "trimestre" | "annee";

function periode(d: Date, pas: Pas): string {
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
  if (pas === "annee") return String(y);
  if (pas === "trimestre") return `${y}-T${Math.floor((m - 1) / 3) + 1}`;
  if (pas === "mois") return `${y}-${String(m).padStart(2, "0")}`;
  if (pas === "semaine") { const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate())); const j = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - j); return t.toISOString().slice(0, 10); }
  return d.toISOString().slice(0, 10);
}

/** La SÉRIE : une mesure par période, périodes vides comprises (un mois sans vente vaut 0, pas « absent »). */
export function serie(lignes: readonly Ligne[], colonneDate: string, mesure: Mesure, pas: Pas = "mois"): { points: { periode: string; valeur: number | null; n: number }[]; ignores: Ignore[] } {
  const parPeriode = new Map<string, unknown[]>();
  let illisibles = 0;
  for (const l of lignes) {
    const d = date(l[colonneDate]);
    if (!d) { illisibles += 1; continue; }
    const k = periode(d, pas);
    parPeriode.set(k, [...(parPeriode.get(k) ?? []), l[mesure.colonne]]);
  }
  const cles = [...parPeriode.keys()].sort();
  const points = cles.map((k) => ({ periode: k, valeur: agreger(parPeriode.get(k)!, mesure.agregat).valeur, n: parPeriode.get(k)!.length }));
  const ignores: Ignore[] = illisibles ? [{ colonne: colonneDate, ignorees: illisibles, raison: "date illisible" }] : [];
  // Combler les mois vides entre la première et la dernière période (pas mensuel : le plus courant).
  if (pas === "mois" && cles.length >= 2) {
    const [a, b] = [cles[0], cles[cles.length - 1]];
    const complets: typeof points = [];
    let [y, m] = a.split("-").map(Number);
    const [yb, mb] = b.split("-").map(Number);
    while (y < yb || (y === yb && m <= mb)) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      complets.push(points.find((p) => p.periode === k) ?? { periode: k, valeur: mesure.agregat === "sum" || mesure.agregat === "count" ? 0 : null, n: 0 });
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return { points: complets, ignores };
  }
  return { points, ignores };
}

export function moyenneMobile(valeurs: readonly (number | null)[], fenetre: number): (number | null)[] {
  return valeurs.map((_, i) => {
    const tranche = valeurs.slice(Math.max(0, i - fenetre + 1), i + 1).filter((v): v is number => v !== null);
    return tranche.length === fenetre ? tranche.reduce((a, b) => a + b, 0) / fenetre : null;
  });
}

/** Croissance d'une période à l'autre, en % — null quand la base est nulle (pas d'infini déguisé en chiffre). */
export function croissance(valeurs: readonly (number | null)[]): (number | null)[] {
  return valeurs.map((v, i) => { const p = i > 0 ? valeurs[i - 1] : null; return v === null || p === null || p === 0 ? null : Math.round(((v - p) / Math.abs(p)) * 1000) / 10; });
}

export function cumul(valeurs: readonly (number | null)[]): (number | null)[] {
  let s = 0; return valeurs.map((v) => (v === null ? null : (s += v)));
}

/** La TENDANCE : régression linéaire sur l'index de période — pente par période et R² (la part expliquée, pas une promesse). */
export function tendance(valeurs: readonly (number | null)[]): { pente: number; ordonnee: number; r2: number; n: number } | null {
  const pts = valeurs.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n; const my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0); const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  if (sxx === 0) return null;
  const pente = sxy / sxx; const ordonnee = my - pente * mx;
  const sst = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0); const sse = pts.reduce((s, p) => s + (p[1] - (ordonnee + pente * p[0])) ** 2, 0);
  return { pente, ordonnee, r2: sst === 0 ? 1 : Math.max(0, 1 - sse / sst), n };
}

// ─────────────────────────────── Fenêtres, anomalies, cohortes, scénarios ───────────────────────────────

export function rang(lignes: readonly Ligne[], colonne: string, alias = "rang"): Ligne[] {
  return trier(lignes, colonne, "desc").map((l, i) => ({ ...l, [alias]: i + 1 }));
}

/**
 * LES ANOMALIES par z-score ROBUSTE (médiane et MAD) : un pic ne déplace pas la mesure qui le
 * juge. Seuil 3,5 (Iglewicz–Hoaglin). Moins de huit valeurs : rien — la fausse précision est
 * pire que le silence.
 */
export function anomalies(lignes: readonly Ligne[], colonne: string, seuil = 3.5): { lignes: (Ligne & { z: number })[]; mediane: number | null; mad: number | null } {
  const nums = lignes.map((l) => nombre(l[colonne]));
  const valides = nums.filter((n): n is number => n !== null);
  if (valides.length < 8) return { lignes: [], mediane: mediane(valides), mad: null };
  const med = mediane(valides)!;
  const mad = mediane(valides.map((v) => Math.abs(v - med)))!;
  if (mad === 0) return { lignes: [], mediane: med, mad };
  const out: (Ligne & { z: number })[] = [];
  lignes.forEach((l, i) => { const v = nums[i]; if (v === null) return; const z = (0.6745 * (v - med)) / mad; if (Math.abs(z) > seuil) out.push({ ...l, z: Math.round(z * 100) / 100 }); });
  return { lignes: out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)), mediane: med, mad };
}

/** COHORTES : les entités groupées par période de première apparition, puis leur présence aux périodes suivantes (rétention). */
export function cohortes(lignes: readonly Ligne[], colonneEntite: string, colonneDate: string, pas: Pas = "mois"): { cohortes: { cohorte: string; taille: number; retention: number[] }[]; periodes: string[] } {
  const premiere = new Map<string, string>(); const presence = new Map<string, Set<string>>();
  for (const l of lignes) {
    const d = date(l[colonneDate]); const e = String(l[colonneEntite] ?? "");
    if (!d || !e) continue;
    const p = periode(d, pas);
    if (!premiere.has(e) || p < premiere.get(e)!) premiere.set(e, p);
    const vu = presence.get(e);
    if (vu) vu.add(p); else presence.set(e, new Set([p]));
  }
  const periodes = [...new Set([...presence.values()].flatMap((s) => [...s]))].sort();
  const parCohorte = new Map<string, string[]>();
  for (const [e, p] of premiere) parCohorte.set(p, [...(parCohorte.get(p) ?? []), e]);
  const out = [...parCohorte.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cohorte, entites]) => {
    const debut = periodes.indexOf(cohorte);
    const retention = periodes.slice(debut).map((p) => Math.round((100 * entites.filter((e) => presence.get(e)!.has(p)).length) / entites.length));
    return { cohorte, taille: entites.length, retention };
  });
  return { cohortes: out, periodes };
}

/** SCÉNARIO : appliquer des variations (en %) à des colonnes et recalculer une mesure — hypothèses dites, jamais appliquées à la base. */
export function scenario(lignes: readonly Ligne[], variations: readonly { colonne: string; pourcent: number }[], mesure: Mesure): { base: number | null; scenario: number | null; ecart: number | null; hypotheses: string[] } {
  const base = agreger(lignes.map((l) => l[mesure.colonne]), mesure.agregat).valeur;
  const modifiees = lignes.map((l) => { const c: Ligne = { ...l }; for (const v of variations) { const n = nombre(c[v.colonne]); if (n !== null) c[v.colonne] = n * (1 + v.pourcent / 100); } return c; });
  const sc = agreger(modifiees.map((l) => l[mesure.colonne]), mesure.agregat).valeur;
  return { base, scenario: sc, ecart: base !== null && sc !== null ? sc - base : null, hypotheses: variations.map((v) => `${v.colonne} ${v.pourcent >= 0 ? "+" : ""}${v.pourcent} %`) };
}

/** Les opérations exposées au bac à sable, par nom — la surface est FERMÉE et documentée. */
export const OPERATIONS = {
  decrire, regrouper, croiser, filtrer, trier, serie, moyenneMobile, croissance, cumul, tendance, rang, anomalies, cohortes, scenario, mediane, percentile,
} as const;
