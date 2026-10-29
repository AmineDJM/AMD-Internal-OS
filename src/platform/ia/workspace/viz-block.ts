import {
  VIZ_TYPES, WORKSPACE_LIMITS,
  type VizArbre, type VizArc, type VizCarte, type VizDonnees, type VizLieu, type VizNoeud, type VizPoint, type VizSerie, type VizTache, type VizType,
  type WorkspaceBlock, type WorkspaceTone,
} from "./protocol";
import { actionsOf, arr, clip, isInternalHref, isObj, s, TONES, type Json } from "./read";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REPRÉSENTATION GÉNÉRIQUE, côté serveur (mandat 5 §35) — pur : rien d'autre que le protocole.
 *
 * Deux choses vivent ici, et rien d'autre :
 *
 *   1. LE LECTEUR (`readVizBlock`, `readDashboardBlock`). Ce qu'un outil DÉCLARE montrer est relu
 *      champ par champ, borné, typé — une forme inconnue, une famille de données qui ne correspond
 *      pas à la forme, un arc vers un nœud absent, une date qui n'en est pas une : refusé, pas
 *      « affiché à peu près ». Même exigence que pour tous les `_blocs` (compose.ts) : un bloc qui
 *      ne passe pas n'existe pas.
 *
 *   2. LES CONSTRUCTEURS (`construireViz`). Des LIGNES — résultat d'une lecture, d'une analyse,
 *      d'une requête — aux données d'une forme : agrégation, pivot, classes d'effectif, réseau
 *      depuis de/à, arbre depuis parent/enfant. Le CODE agrège ; le modèle ne recopie jamais des
 *      chiffres dans un graphique, il nomme les colonnes.
 *
 * Aucune forme n'a de composant React : le client rend `type` avec UN rendu générique
 * (`components/chief/workspace/blocks/viz-figure.tsx`). Ajouter une forme = un cas ici (les
 * données qu'elle exige) + un cas là (son dessin). Jamais un fichier par graphique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Ligne = Record<string, unknown>;
export type Famille = "series" | "points" | "grille" | "cellules" | "taches" | "reseau" | "arbre" | "lieux" | "cartes";

/** Quelle FAMILLE de données chaque forme exige. Le lecteur refuse tout le reste. */
export const FAMILLE: Record<VizType, Famille> = {
  barres: "series", barres_empilees: "series", courbe: "series", aires: "series", histogramme: "series",
  secteurs: "series", cascade: "series", entonnoir: "series",
  nuage: "points", heatmap: "grille", matrice: "cellules", gantt: "taches",
  graphe: "reseau", flux: "reseau", arbre: "arbre", carte: "lieux", cartes: "cartes",
};

/** Ce que chaque famille attend — dit au modèle quand il se trompe de forme, jamais deviné pour lui. */
export const ATTENDU: Record<Famille, string> = {
  series: "categories: string[] + series: [{ label, valeurs: number[] }]",
  points: "points: [{ x, y, label?, taille?, groupe? }]",
  grille: "lignes: string[], colonnes: string[], valeurs: (number|null)[][]",
  cellules: "lignes: string[], colonnes: string[], cellules: string[][], tons?: (neutre|succes|attention|alerte|null)[][]",
  taches: "taches: [{ label, debut: 'AAAA-MM-JJ', fin: 'AAAA-MM-JJ', groupe?, progression? (0-100), ton? }]",
  reseau: "noeuds: [{ id, label, type?, poids?, ton?, href? }] + arcs: [{ de, a, label?, poids? }]",
  arbre: "racine: { label, valeur?, ton?, enfants?: [...] }",
  lieux: "lieux: [{ label, lat, lon, valeur?, ton? }]",
  cartes: "cartes: [{ titre, valeur, detail?, ton?, href? }]",
};

const L = WORKSPACE_LIMITS;

export const isVizType = (v: unknown): v is VizType => typeof v === "string" && (VIZ_TYPES as readonly string[]).includes(v);
const ton = (v: unknown): WorkspaceTone | undefined => (typeof v === "string" && TONES.has(v) ? (v as WorkspaceTone) : undefined);
const avecTon = (v: unknown): { ton?: WorkspaceTone } => { const t = ton(v); return t ? { ton: t } : {}; };

/** Un nombre — accepte « 12 500,5 » et « 12500.5 » : les lignes viennent aussi de fichiers. */
export const nb = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
/** Un libellé — un nombre en guise d'étiquette (une année, un rang) reste une étiquette. */
const lib = (v: unknown, max: number): string | null => clip(typeof v === "number" && Number.isFinite(v) ? String(v) : s(v), max);
const libelles = (v: unknown, max: number, taille = 60): string[] =>
  arr(v).map((x) => lib(x, taille)).filter((x): x is string => Boolean(x)).slice(0, max);

const DATE_RE = /^\d{4}-\d{2}(-\d{2})?/;
const dateIso = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  const t = s(v);
  if (!t) return null;
  const ms = Date.parse(/^\d{4}-\d{2}$/.test(t) ? `${t}-01` : t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

// ─────────────────────────────── LE LECTEUR — famille par famille ───────────────────────────────

function lireSeries(d: Json): VizDonnees | null {
  const categories = libelles(d.categories ?? d.labels, L.vizCategories);
  if (!categories.length) return null;
  const brutes = Array.isArray(d.series) ? d.series : Array.isArray(d.valeurs) ? [{ label: lib(d.libelle, 40) ?? "Valeur", valeurs: d.valeurs }] : [];
  const series: VizSerie[] = [];
  for (const x of brutes) {
    if (!isObj(x)) continue;
    const brut = arr(x.valeurs ?? x.values);
    const valeurs = categories.map((_, i) => nb(brut[i]));
    if (valeurs.every((v) => v === null)) continue;
    series.push({ label: lib(x.label ?? x.libelle, 40) ?? `Série ${series.length + 1}`, valeurs, ...avecTon(x.ton) });
    if (series.length >= L.vizSeries) break;
  }
  return series.length ? { categories, series } : null;
}

function lirePoints(d: Json): VizDonnees | null {
  const points: VizPoint[] = [];
  for (const p of arr(d.points)) {
    if (!isObj(p)) continue;
    const x = nb(p.x); const y = nb(p.y);
    if (x === null || y === null) continue;
    const taille = nb(p.taille ?? p.size);
    points.push({ x, y, label: lib(p.label, 40), taille: taille !== null && taille >= 0 ? taille : null, groupe: lib(p.groupe ?? p.serie, 30) });
    if (points.length >= L.vizPoints) break;
  }
  return points.length ? { points } : null;
}

function lireGrille(d: Json): VizDonnees | null {
  const lignes = libelles(d.lignes ?? d.rows, L.vizCellules);
  const colonnes = libelles(d.colonnes ?? d.columns, L.vizCellules);
  if (!lignes.length || !colonnes.length) return null;
  const brut = arr(d.valeurs ?? d.values);
  const valeurs = lignes.map((_, i) => { const r = arr(brut[i]); return colonnes.map((__, j) => nb(r[j])); });
  if (!valeurs.some((r) => r.some((v) => v !== null))) return null;
  return { lignes, colonnes, valeurs };
}

function lireCellules(d: Json): VizDonnees | null {
  const lignes = libelles(d.lignes ?? d.rows, L.vizCellules);
  const colonnes = libelles(d.colonnes ?? d.columns, L.vizCellules);
  if (!lignes.length || !colonnes.length) return null;
  const brut = arr(d.cellules ?? d.cells);
  const cellules = lignes.map((_, i) => { const r = arr(brut[i]); return colonnes.map((__, j) => lib(r[j], 40) ?? ""); });
  if (!cellules.some((r) => r.some((c) => c !== ""))) return null;
  const tonsBrut = arr(d.tons);
  const tons = tonsBrut.length ? lignes.map((_, i) => { const r = arr(tonsBrut[i]); return colonnes.map((__, j) => ton(r[j]) ?? null); }) : undefined;
  return { lignes, colonnes, cellules, ...(tons ? { tons } : {}) };
}

function lireTaches(d: Json): VizDonnees | null {
  const taches: VizTache[] = [];
  for (const t of arr(d.taches ?? d.tasks)) {
    if (!isObj(t)) continue;
    const label = lib(t.label ?? t.libelle ?? t.titre, 60);
    const debut = dateIso(t.debut ?? t.start); const fin = dateIso(t.fin ?? t.end);
    if (!label || !debut || !fin || fin < debut) continue;
    const progression = nb(t.progression);
    taches.push({
      label, debut, fin, groupe: lib(t.groupe, 30),
      progression: progression === null ? null : Math.max(0, Math.min(100, progression)),
      ...avecTon(t.ton),
    });
    if (taches.length >= L.vizTaches) break;
  }
  return taches.length ? { taches } : null;
}

function lireReseau(d: Json, type: VizType): VizDonnees | null {
  const noeuds: VizNoeud[] = [];
  const ids = new Set<string>();
  for (const n of arr(d.noeuds ?? d.nodes)) {
    if (!isObj(n)) continue;
    const id = lib(n.id ?? n.label, 80);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const href = s(n.href);
    const poids = nb(n.poids ?? n.valeur);
    noeuds.push({ id, label: lib(n.label, 60) ?? id, type: lib(n.type, 30), poids: poids !== null && poids >= 0 ? poids : null, ...avecTon(n.ton), href: href && isInternalHref(href) ? href : null });
    if (noeuds.length >= L.vizNoeuds) break;
  }
  const arcs: VizArc[] = [];
  for (const a of arr(d.arcs ?? d.edges ?? d.liens)) {
    if (!isObj(a)) continue;
    const de = lib(a.de ?? a.source ?? a.from, 80); const vers = lib(a.a ?? a.vers ?? a.cible ?? a.target ?? a.to, 80);
    if (!de || !vers || !ids.has(de) || !ids.has(vers) || de === vers) continue; // un arc vers un nœud absent n'est pas dessiné « à peu près »
    const poids = nb(a.poids ?? a.valeur);
    arcs.push({ de, a: vers, label: lib(a.label, 40), poids: poids !== null && poids >= 0 ? poids : null });
    if (arcs.length >= L.vizArcs) break;
  }
  if (!noeuds.length) return null;
  if (type === "flux" && !arcs.length) return null; // un flux sans flux n'est rien
  return { noeuds, arcs };
}

function lireArbre(d: Json): VizDonnees | null {
  let compte = 0;
  const lire = (v: unknown, prof: number): VizArbre | null => {
    if (!isObj(v) || prof > 6 || compte >= L.vizArbre) return null;
    const label = lib(v.label ?? v.libelle ?? v.nom, 60);
    if (!label) return null;
    compte += 1;
    const enfants = arr(v.enfants ?? v.children).map((e) => lire(e, prof + 1)).filter((e): e is VizArbre => Boolean(e));
    return { label, valeur: nb(v.valeur), ...avecTon(v.ton), ...(enfants.length ? { enfants } : {}) };
  };
  const racine = lire(d.racine ?? d.root ?? d.arbre, 0);
  return racine ? { racine } : null;
}

function lireLieux(d: Json): VizDonnees | null {
  const lieux: VizLieu[] = [];
  for (const l of arr(d.lieux ?? d.places)) {
    if (!isObj(l)) continue;
    const label = lib(l.label ?? l.nom, 60); const lat = nb(l.lat ?? l.latitude); const lon = nb(l.lon ?? l.lng ?? l.longitude);
    if (!label || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const valeur = nb(l.valeur);
    lieux.push({ label, lat, lon, valeur: valeur !== null && valeur >= 0 ? valeur : null, ...avecTon(l.ton) });
    if (lieux.length >= L.vizNoeuds) break;
  }
  return lieux.length ? { lieux } : null;
}

function lireCartes(d: Json): VizDonnees | null {
  const cartes: VizCarte[] = [];
  for (const c of arr(d.cartes ?? d.cards ?? d.indicateurs)) {
    if (!isObj(c)) continue;
    const titre = lib(c.titre ?? c.label, 60); const valeur = lib(c.valeur ?? c.value, 40);
    if (!titre || valeur === null) continue;
    const href = s(c.href);
    cartes.push({ titre, valeur, detail: lib(c.detail, 80), ...avecTon(c.ton), href: href && isInternalHref(href) ? href : null });
    if (cartes.length >= L.vizCartes) break;
  }
  return cartes.length ? { cartes } : null;
}

/** Les données d'une forme, relues : la bonne famille, bornée — ou rien. */
export function lireDonnees(type: VizType, d: Json): VizDonnees | null {
  switch (FAMILLE[type]) {
    case "series": return lireSeries(d);
    case "points": return lirePoints(d);
    case "grille": return lireGrille(d);
    case "cellules": return lireCellules(d);
    case "taches": return lireTaches(d);
    case "reseau": return lireReseau(d, type);
    case "arbre": return lireArbre(d);
    case "lieux": return lireLieux(d);
    case "cartes": return lireCartes(d);
  }
}

/** Un bloc `viz` déclaré par un outil, relu champ par champ. */
export function readVizBlock(v: Json, title: string): WorkspaceBlock | null {
  const type = v.type;
  if (!isVizType(type)) return null;
  const d = isObj(v.donnees) ? v.donnees : isObj(v.data) ? v.data : null;
  if (!d) return null;
  const donnees = lireDonnees(type, d);
  if (!donnees) return null;
  const actions = actionsOf(v.actions, L.blockActions);
  return {
    kind: "viz", title, type, donnees,
    unite: clip(s(v.unite), 20),
    axeYdepartZero: typeof v.axeYdepartZero === "boolean" ? v.axeYdepartZero : undefined,
    note: clip(s(v.note), 300), raison: clip(s(v.raison), 300),
    alertes: libelles(v.alertes, 6, 220), source: clip(s(v.source), 160),
    ...(actions.length ? { actions } : {}),
  };
}

/**
 * Un MINI-TABLEAU DE BORD déclaré : des tuiles relues UNE À UNE par le lecteur général — une
 * tuile invalide tombe, les autres restent. Pas de tableau de bord dans un tableau de bord.
 */
export function readDashboardBlock(v: Json, title: string, lire: (x: unknown) => WorkspaceBlock | null): WorkspaceBlock | null {
  const tuiles: WorkspaceBlock[] = [];
  for (const t of arr(v.tuiles ?? v.tiles)) {
    if (!isObj(t) || t.kind === "dashboard") continue;
    const b = lire(t);
    if (b) tuiles.push(b);
    if (tuiles.length >= L.tuiles) break;
  }
  if (!tuiles.length) return null;
  const colonnes = v.colonnes === 3 ? 3 : v.colonnes === 2 ? 2 : tuiles.length >= 5 ? 3 : 2;
  const actions = actionsOf(v.actions, L.blockActions);
  return { kind: "dashboard", title, colonnes, tuiles, note: clip(s(v.note), 300), ...(actions.length ? { actions } : {}) };
}

// ─────────────────────────── LES CONSTRUCTEURS — des lignes à une forme ───────────────────────────

export interface DemandeViz {
  type: VizType;
  /** La colonne de catégorie / de temps (barres, courbe…), des lignes (heatmap, matrice), des abscisses (nuage). */
  x?: string | null;
  /** Les mesures. Plusieurs mesures = plusieurs séries (sauf si `serie` pivote). */
  y?: readonly string[] | null;
  /** La colonne qui PIVOTE en séries (barres empilées, courbes multiples) ou en colonnes (heatmap, matrice). */
  serie?: string | null;
  agregat?: "somme" | "moyenne" | "compte" | "min" | "max" | null;
  tri?: "valeur" | "libelle" | "aucun" | null;
  label?: string | null; detail?: string | null; taille?: string | null; groupe?: string | null; progression?: string | null;
  debut?: string | null; fin?: string | null;
  de?: string | null; a?: string | null; poids?: string | null; parent?: string | null;
  lat?: string | null; lon?: string | null;
}

export interface Construction {
  donnees: VizDonnees;
  /** Les colonnes effectivement utilisées — dites au modèle, pour qu'il sache ce qu'il montre. */
  colonnes: Record<string, string | readonly string[] | null | undefined>;
  notes: string[];
}

export interface ProfilColonne { nom: string; type: "nombre" | "date" | "texte"; distincts: number }

/** Le profil des colonnes : type majoritaire, cardinalité — local et léger, sans le bac à sable. */
export function profiler(lignes: readonly Ligne[]): ProfilColonne[] {
  const noms = new Set<string>();
  for (const l of lignes.slice(0, 500)) for (const k of Object.keys(l)) noms.add(k);
  return [...noms].map((nom) => {
    let n = 0, d = 0, t = 0;
    const vus = new Set<string>();
    for (const l of lignes) {
      const v = l[nom];
      if (v === null || v === undefined || v === "") continue;
      vus.add(String(v));
      if (typeof v === "number" || typeof v === "boolean") n += 1;
      else if (v instanceof Date) d += 1;
      else if (typeof v === "string" && DATE_RE.test(v.trim())) d += 1;
      else if (typeof v === "string" && /^-?[\d\s]+([.,]\d+)?$/.test(v.trim())) n += 1;
      else t += 1;
    }
    const type = n >= d && n >= t && n > 0 ? "nombre" : d >= t && d > 0 ? "date" : "texte";
    return { nom, type, distincts: vus.size };
  });
}

const plier = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const nombreFr = (v: number): string =>
  Number.isInteger(v) ? v.toLocaleString("fr-FR") : v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

function agreger(vals: readonly number[], mode: NonNullable<DemandeViz["agregat"]>): number | null {
  if (mode === "compte") return vals.length;
  if (!vals.length) return null;
  switch (mode) {
    case "somme": return vals.reduce((a, b) => a + b, 0);
    case "moyenne": return vals.reduce((a, b) => a + b, 0) / vals.length;
    case "min": return Math.min(...vals);
    case "max": return Math.max(...vals);
  }
}

/** Un « pas lisible » pour des classes d'effectif (1, 2, 5 × 10^k). */
function pasLisible(brut: number): number {
  if (!(brut > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(brut));
  const r = brut / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}

const SEP = "\u001f";

/**
 * CONSTRUIRE les données d'une forme depuis des lignes. Les colonnes sont résolues sans casse ni
 * accents ; celles qui manquent sont DÉDUITES quand il n'y a qu'une lecture raisonnable (première
 * colonne de texte pour la catégorie, colonnes numériques pour les mesures) et REFUSÉES sinon,
 * avec la liste des colonnes — jamais inventées.
 */
export function construireViz(demande: DemandeViz, lignes: readonly Ligne[]): Construction | { erreur: string } {
  const propres = lignes.filter(isObj);
  if (!propres.length) return { erreur: "aucune ligne à représenter" };
  const profil = profiler(propres);
  const noms = profil.map((c) => c.nom);
  const col = (nom: string | null | undefined): string | null => {
    if (!nom) return null;
    const exact = noms.find((n) => n === nom);
    if (exact) return exact;
    const p = plier(nom);
    return noms.find((n) => plier(n) === p) ?? null;
  };
  const inconnues = (["x", "serie", "label", "detail", "taille", "groupe", "progression", "debut", "fin", "de", "a", "poids", "parent", "lat", "lon"] as const)
    .map((k) => [k, demande[k]] as const)
    .filter(([, v]) => typeof v === "string" && v.trim() !== "" && !col(v))
    .map(([k, v]) => `${k} = « ${v} »`);
  const yInconnues = (demande.y ?? []).filter((y) => !col(y)).map((y) => `y = « ${y} »`);
  if (inconnues.length || yInconnues.length) return { erreur: `colonne(s) introuvable(s) : ${[...inconnues, ...yInconnues].join(", ")} — colonnes disponibles : ${noms.join(", ")}` };

  const nombres = profil.filter((c) => c.type === "nombre").map((c) => c.nom);
  const textes = profil.filter((c) => c.type !== "nombre").map((c) => c.nom);
  const notes: string[] = [];
  const type = demande.type;
  const famille = FAMILLE[type];

  if (famille === "series" && type === "histogramme") {
    const xcol = col(demande.x) ?? col(demande.y?.[0]) ?? nombres[0] ?? null;
    if (!xcol) return { erreur: `un histogramme exige une colonne numérique — colonnes : ${noms.join(", ")}` };
    const vals = propres.map((l) => nb(l[xcol])).filter((v): v is number => v !== null);
    if (vals.length < 2) return { erreur: `« ${xcol} » ne porte pas assez de valeurs numériques` };
    const min = Math.min(...vals); const max = Math.max(...vals);
    const k = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(vals.length))));
    const pas = pasLisible((max - min) / k || 1);
    const depart = Math.floor(min / pas) * pas;
    const nbClasses = Math.max(1, Math.ceil((max - depart) / pas) || 1);
    const effectifs = Array.from({ length: nbClasses }, () => 0);
    for (const v of vals) effectifs[Math.min(nbClasses - 1, Math.floor((v - depart) / pas))] += 1;
    const categories = effectifs.map((_, i) => `${nombreFr(depart + i * pas)} – ${nombreFr(depart + (i + 1) * pas)}`);
    return { donnees: { categories, series: [{ label: "Effectif", valeurs: effectifs }] }, colonnes: { x: xcol, y: ["effectif"], serie: null }, notes };
  }

  if (famille === "series") {
    const xcol = col(demande.x) ?? profil.find((c) => c.type === "date")?.nom ?? textes[0] ?? null;
    if (!xcol) return { erreur: `aucune colonne de catégorie (x) — colonnes : ${noms.join(", ")}` };
    const serieCol = col(demande.serie);
    let ys = (demande.y ?? []).map((y) => col(y)).filter((y): y is string => Boolean(y));
    let mode: NonNullable<DemandeViz["agregat"]> = demande.agregat ?? (ys.length ? "somme" : "compte");
    if (!ys.length && mode !== "compte") ys = nombres.filter((n) => n !== xcol && n !== serieCol).slice(0, L.vizSeries);
    if (!ys.length && demande.agregat && demande.agregat !== "compte") return { erreur: `aucune mesure numérique (y) pour « ${demande.agregat} » — colonnes : ${noms.join(", ")}` };
    if (!ys.length) mode = "compte";
    if (serieCol && ys.length > 1) { notes.push(`avec « ${serieCol} » en séries, seule la mesure « ${ys[0]} » est représentée`); ys = ys.slice(0, 1); }

    // Regrouper : catégorie → clé de série → valeurs.
    const ordre: string[] = [];
    const groupes = new Map<string, Map<string, number[]>>();
    const clesSeries = new Set<string>();
    for (const l of propres) {
      const cat = lib(l[xcol], 60) ?? "(vide)";
      if (!groupes.has(cat)) { groupes.set(cat, new Map()); ordre.push(cat); }
      const g = groupes.get(cat)!;
      if (serieCol) {
        const cle = lib(l[serieCol], 40) ?? "(vide)";
        clesSeries.add(cle);
        const v = ys.length ? nb(l[ys[0]]) : 1;
        if (!g.has(cle)) g.set(cle, []);
        if (v !== null) g.get(cle)!.push(v);
      } else if (ys.length) {
        for (const y of ys) { const v = nb(l[y]); if (!g.has(y)) g.set(y, []); if (v !== null) g.get(y)!.push(v); }
      } else {
        if (!g.has("Effectif")) g.set("Effectif", []);
        g.get("Effectif")!.push(1);
      }
    }
    let cles = serieCol ? [...clesSeries] : ys.length ? ys : ["Effectif"];
    if (serieCol && cles.length > L.vizSeries) {
      const totaux = cles.map((c) => [c, [...groupes.values()].reduce((s0, g) => s0 + (agreger(g.get(c) ?? [], mode) ?? 0), 0)] as const).sort((a, b) => b[1] - a[1]);
      const gardees = totaux.slice(0, L.vizSeries - 1).map(([c]) => c);
      const autres = totaux.slice(L.vizSeries - 1).map(([c]) => c);
      for (const g of groupes.values()) {
        const fusion = autres.flatMap((c) => g.get(c) ?? []);
        for (const c of autres) g.delete(c);
        g.set("Autres", fusion);
      }
      cles = [...gardees, "Autres"];
      notes.push(`${totaux.length} séries : les ${L.vizSeries - 1} plus fortes sont montrées, le reste est regroupé dans « Autres »`);
    }
    const total = (cat: string) => cles.reduce((s0, c) => s0 + (agreger(groupes.get(cat)?.get(c) ?? [], mode) ?? 0), 0);
    const xEstTemps = profil.find((c) => c.nom === xcol)?.type === "date" || ordre.every((c) => /^\d{4}([-/]\d{2})?([-/]\d{2})?$|^\d{4}-T[1-4]$|^T[1-4] \d{4}$/.test(c));
    let categories = [...ordre];
    const tri = demande.tri ?? (type === "cascade" ? "aucun" : xEstTemps ? "libelle" : type === "courbe" || type === "aires" ? "libelle" : "valeur");
    if (tri === "valeur") categories.sort((a, b) => total(b) - total(a));
    else if (tri === "libelle") categories.sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
    if (type === "secteurs" && categories.length > 6) {
      const gardees = categories.slice(0, 5); const autres = categories.slice(5);
      const fusion = new Map<string, number[]>();
      for (const c of cles) fusion.set(c, autres.flatMap((cat) => groupes.get(cat)?.get(c) ?? []));
      groupes.set("Autres", fusion);
      categories = [...gardees, "Autres"];
      notes.push(`${ordre.length} parts : les 5 plus fortes sont montrées, le reste est regroupé dans « Autres »`);
    } else if (categories.length > L.vizCategories) {
      notes.push(`${categories.length} catégories : les ${L.vizCategories} ${tri === "valeur" ? "plus fortes" : "premières"} sont montrées`);
      categories = categories.slice(0, L.vizCategories);
    }
    const series: VizSerie[] = cles.map((c) => ({ label: c, valeurs: categories.map((cat) => agreger(groupes.get(cat)?.get(c) ?? [], mode)) }));
    return { donnees: { categories, series }, colonnes: { x: xcol, y: ys.length ? ys : ["effectif"], serie: serieCol, agregat: mode }, notes };
  }

  if (famille === "points") {
    const xcol = col(demande.x) ?? nombres[0] ?? null;
    const ycol = col(demande.y?.[0]) ?? nombres.find((n) => n !== xcol) ?? null;
    if (!xcol || !ycol) return { erreur: `un nuage exige deux colonnes numériques (x, y) — colonnes : ${noms.join(", ")}` };
    const labelCol = col(demande.label) ?? textes[0] ?? null;
    const tailleCol = col(demande.taille); const groupeCol = col(demande.groupe) ?? col(demande.serie);
    const points: VizPoint[] = [];
    for (const l of propres) {
      const x = nb(l[xcol]); const y = nb(l[ycol]);
      if (x === null || y === null) continue;
      points.push({ x, y, label: labelCol ? lib(l[labelCol], 40) : null, taille: tailleCol ? nb(l[tailleCol]) : null, groupe: groupeCol ? lib(l[groupeCol], 30) : null });
      if (points.length >= L.vizPoints) { notes.push(`${L.vizPoints} points montrés sur ${propres.length}`); break; }
    }
    if (!points.length) return { erreur: `aucun point numérique dans « ${xcol} » × « ${ycol} »` };
    return { donnees: { points }, colonnes: { x: xcol, y: [ycol], label: labelCol, taille: tailleCol, groupe: groupeCol }, notes };
  }

  if (famille === "grille" || famille === "cellules") {
    const xcol = col(demande.x) ?? textes[0] ?? null;
    const serieCol = col(demande.serie) ?? textes.find((t) => t !== xcol) ?? null;
    if (!xcol || !serieCol) return { erreur: `une ${type} exige une colonne de lignes (x) et une colonne de colonnes (serie) — colonnes : ${noms.join(", ")}` };
    const ycol = col(demande.y?.[0]) ?? nombres.find((n) => n !== xcol && n !== serieCol) ?? null;
    const mode: NonNullable<DemandeViz["agregat"]> = demande.agregat ?? (ycol ? "somme" : "compte");
    const labelCol = famille === "cellules" ? col(demande.label) : null;
    const grille = new Map<string, Map<string, number[]>>();
    const textesCell = new Map<string, Map<string, string>>();
    const poidsCol = new Map<string, number>();
    for (const l of propres) {
      const r = lib(l[xcol], 40) ?? "(vide)"; const c = lib(l[serieCol], 40) ?? "(vide)";
      if (!grille.has(r)) { grille.set(r, new Map()); textesCell.set(r, new Map()); }
      const v = ycol ? nb(l[ycol]) : 1;
      poidsCol.set(c, (poidsCol.get(c) ?? 0) + (v ?? 0));
      const cell = grille.get(r)!;
      if (!cell.has(c)) cell.set(c, []);
      if (v !== null) cell.get(c)!.push(v);
      if (famille === "cellules") {
        const t = labelCol ? lib(l[labelCol], 40) : null;
        if (t) textesCell.get(r)!.set(c, t);
      }
    }
    const lignesL = [...grille.keys()];
    let colonnes = [...poidsCol.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    if (colonnes.length > L.vizCellules) { notes.push(`${colonnes.length} colonnes : les ${L.vizCellules} plus fortes sont montrées`); colonnes = colonnes.slice(0, L.vizCellules); }
    if (colonnes.every((c) => /^\d{4}([-/]\d{2})?([-/]\d{2})?$/.test(c))) colonnes.sort();
    const totalLigne = (r: string) => colonnes.reduce((s0, c) => s0 + (agreger(grille.get(r)?.get(c) ?? [], mode) ?? 0), 0);
    let lignesR = lignesL;
    if (lignesR.length > L.vizCellules) {
      lignesR = [...lignesR].sort((a, b) => totalLigne(b) - totalLigne(a)).slice(0, L.vizCellules);
      notes.push(`${lignesL.length} lignes : les ${L.vizCellules} plus fortes sont montrées`);
    }
    if (famille === "cellules") {
      const cellules = lignesR.map((r) => colonnes.map((c) => {
        const t = textesCell.get(r)?.get(c);
        if (t) return t;
        const vals = grille.get(r)?.get(c) ?? [];
        const v = agreger(vals, mode);
        return v === null || (!ycol && vals.length === 0) ? "" : nombreFr(v);
      }));
      return { donnees: { lignes: lignesR, colonnes, cellules }, colonnes: { x: xcol, serie: serieCol, label: labelCol ?? ycol }, notes };
    }
    const valeurs = lignesR.map((r) => colonnes.map((c) => { const vals = grille.get(r)?.get(c); return vals && (ycol ? vals.length > 0 : true) ? agreger(vals, mode) : null; }));
    return { donnees: { lignes: lignesR, colonnes, valeurs }, colonnes: { x: xcol, serie: serieCol, y: ycol ? [ycol] : ["effectif"], agregat: mode }, notes };
  }

  if (famille === "taches") {
    const dates = profil.filter((c) => c.type === "date").map((c) => c.nom);
    const labelCol = col(demande.label) ?? col(demande.x) ?? textes.find((t) => !dates.includes(t)) ?? null;
    const debutCol = col(demande.debut) ?? dates[0] ?? null;
    const finCol = col(demande.fin) ?? dates.find((d) => d !== debutCol) ?? null;
    if (!labelCol || !debutCol || !finCol) return { erreur: `un Gantt exige un libellé, une date de début et une date de fin — colonnes : ${noms.join(", ")}` };
    const groupeCol = col(demande.groupe) ?? col(demande.serie); const progCol = col(demande.progression);
    const taches: VizTache[] = [];
    for (const l of propres) {
      const label = lib(l[labelCol], 60); const debut = dateIso(l[debutCol]); const fin = dateIso(l[finCol]);
      if (!label || !debut || !fin || fin < debut) continue;
      const p = progCol ? nb(l[progCol]) : null;
      taches.push({ label, debut, fin, groupe: groupeCol ? lib(l[groupeCol], 30) : null, progression: p === null ? null : Math.max(0, Math.min(100, p <= 1 && p > 0 ? p * 100 : p)) });
      if (taches.length >= L.vizTaches) { notes.push(`${L.vizTaches} tâches montrées sur ${propres.length}`); break; }
    }
    if (!taches.length) return { erreur: `aucune ligne avec un début et une fin valides dans « ${debutCol} » / « ${finCol} »` };
    taches.sort((a, b) => a.debut.localeCompare(b.debut));
    return { donnees: { taches }, colonnes: { label: labelCol, debut: debutCol, fin: finCol, groupe: groupeCol, progression: progCol }, notes };
  }

  if (famille === "reseau") {
    const deCol = col(demande.de) ?? col(demande.x) ?? textes[0] ?? null;
    const aCol = col(demande.a) ?? col(demande.serie) ?? textes.find((t) => t !== deCol) ?? null;
    if (!deCol || !aCol) return { erreur: `un ${type} exige deux colonnes (de, a) — colonnes : ${noms.join(", ")}` };
    const poidsCol = col(demande.poids) ?? col(demande.y?.[0]) ?? null;
    const arcsM = new Map<string, number>();
    const poidsN = new Map<string, number>();
    for (const l of propres) {
      const de = lib(l[deCol], 60); const a = lib(l[aCol], 60);
      if (!de || !a || de === a) continue;
      const w = poidsCol ? nb(l[poidsCol]) ?? 0 : 1;
      const k = `${de}${SEP}${a}`;
      arcsM.set(k, (arcsM.get(k) ?? 0) + w);
      poidsN.set(de, (poidsN.get(de) ?? 0) + w); poidsN.set(a, (poidsN.get(a) ?? 0) + w);
    }
    if (!arcsM.size) return { erreur: `aucun lien dans « ${deCol} » → « ${aCol} »` };
    let arcsT = [...arcsM.entries()].sort((x, y) => y[1] - x[1]);
    if (arcsT.length > L.vizArcs) { notes.push(`${arcsT.length} liens : les ${L.vizArcs} plus forts sont montrés`); arcsT = arcsT.slice(0, L.vizArcs); }
    const ids = new Set<string>();
    for (const [k] of arcsT) { const [de, a] = k.split(SEP); ids.add(de); ids.add(a); }
    let noeudsT = [...ids].sort((x, y) => (poidsN.get(y) ?? 0) - (poidsN.get(x) ?? 0));
    if (noeudsT.length > L.vizNoeuds) { notes.push(`${noeudsT.length} nœuds : les ${L.vizNoeuds} plus liés sont montrés`); noeudsT = noeudsT.slice(0, L.vizNoeuds); }
    const garde = new Set(noeudsT);
    const noeuds: VizNoeud[] = noeudsT.map((id) => ({ id, label: id, poids: poidsN.get(id) ?? null }));
    const arcs: VizArc[] = arcsT
      .filter(([k]) => { const [de, a] = k.split(SEP); return garde.has(de) && garde.has(a); })
      .map(([k, w]) => { const [de, a] = k.split(SEP); return { de, a, poids: w }; });
    return { donnees: { noeuds, arcs }, colonnes: { de: deCol, a: aCol, poids: poidsCol }, notes };
  }

  if (famille === "arbre") {
    const parentCol = col(demande.parent);
    const labelCol = col(demande.label) ?? col(demande.x) ?? textes.find((t) => t !== parentCol) ?? null;
    if (!parentCol || !labelCol) return { erreur: `un arbre exige une colonne « parent » et un libellé — colonnes : ${noms.join(", ")}` };
    const valCol = col(demande.y?.[0]) ?? nombres[0] ?? null;
    const enfantsDe = new Map<string, string[]>(); const valeurs = new Map<string, number | null>(); const tous = new Set<string>(); const aParent = new Set<string>();
    for (const l of propres) {
      const label = lib(l[labelCol], 60); if (!label) continue;
      tous.add(label); valeurs.set(label, valCol ? nb(l[valCol]) : null);
      const parent = lib(l[parentCol], 60);
      if (parent && parent !== label) { aParent.add(label); if (!enfantsDe.has(parent)) enfantsDe.set(parent, []); enfantsDe.get(parent)!.push(label); tous.add(parent); }
    }
    let compte = 0;
    const construire = (label: string, vus: Set<string>, prof: number): VizArbre | null => {
      if (vus.has(label) || prof > 6 || compte >= L.vizArbre) return null;
      vus.add(label); compte += 1;
      const enfants = (enfantsDe.get(label) ?? []).map((e) => construire(e, vus, prof + 1)).filter((e): e is VizArbre => Boolean(e));
      return { label, valeur: valeurs.get(label) ?? null, ...(enfants.length ? { enfants } : {}) };
    };
    const racines = [...tous].filter((t) => !aParent.has(t));
    if (!racines.length) return { erreur: "aucune racine : chaque ligne a un parent (cycle ?)" };
    const vus = new Set<string>();
    const racine: VizArbre = racines.length === 1
      ? construire(racines[0], vus, 0)!
      : { label: "Ensemble", enfants: racines.map((r) => construire(r, vus, 1)).filter((e): e is VizArbre => Boolean(e)) };
    if (compte >= L.vizArbre) notes.push(`arbre tronqué à ${L.vizArbre} nœuds`);
    return { donnees: { racine }, colonnes: { parent: parentCol, label: labelCol, y: valCol ? [valCol] : null }, notes };
  }

  if (famille === "lieux") {
    const latCol = col(demande.lat) ?? noms.find((n) => /^lat/i.test(n)) ?? null;
    const lonCol = col(demande.lon) ?? noms.find((n) => /^(lon|lng)/i.test(n)) ?? null;
    if (!latCol || !lonCol) return { erreur: `une carte exige des colonnes de latitude et de longitude — colonnes : ${noms.join(", ")}` };
    const labelCol = col(demande.label) ?? col(demande.x) ?? textes[0] ?? null;
    const valCol = col(demande.y?.[0]) ?? nombres.find((n) => n !== latCol && n !== lonCol) ?? null;
    const lieux: VizLieu[] = [];
    for (const l of propres) {
      const lat = nb(l[latCol]); const lon = nb(l[lonCol]);
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      lieux.push({ label: (labelCol ? lib(l[labelCol], 60) : null) ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon, valeur: valCol ? nb(l[valCol]) : null });
      if (lieux.length >= L.vizNoeuds) { notes.push(`${L.vizNoeuds} lieux montrés sur ${propres.length}`); break; }
    }
    if (!lieux.length) return { erreur: `aucune coordonnée valide dans « ${latCol} » / « ${lonCol} »` };
    return { donnees: { lieux }, colonnes: { lat: latCol, lon: lonCol, label: labelCol, y: valCol ? [valCol] : null }, notes };
  }

  // cartes : une ligne = un indicateur.
  const titreCol = col(demande.label) ?? col(demande.x) ?? textes[0] ?? null;
  const valCol = col(demande.y?.[0]) ?? nombres[0] ?? noms.find((n) => n !== titreCol) ?? null;
  if (!titreCol || !valCol) return { erreur: `des cartes exigent un titre et une valeur par ligne — colonnes : ${noms.join(", ")}` };
  const detailCol = col(demande.detail);
  const cartes: VizCarte[] = [];
  for (const l of propres) {
    const titre = lib(l[titreCol], 60); if (!titre) continue;
    const v = l[valCol];
    const valeur = typeof v === "number" ? nombreFr(v) : lib(v, 40);
    if (valeur === null) continue;
    cartes.push({ titre, valeur, detail: detailCol ? lib(l[detailCol], 80) : null });
    if (cartes.length >= L.vizCartes) { if (propres.length > L.vizCartes) notes.push(`${L.vizCartes} cartes montrées sur ${propres.length}`); break; }
  }
  if (!cartes.length) return { erreur: `aucune ligne avec « ${titreCol} » et « ${valCol} »` };
  return { donnees: { cartes }, colonnes: { label: titreCol, y: [valCol], detail: detailCol }, notes };
}
