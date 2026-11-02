import { analyser, nomsDe, referencesDe } from "@/lib/artifact/sheets/formula";
import { cleDe, contient, tailleDe, type Plage } from "@/lib/artifact/sheets/refs";
import { formulesDe, type Classeur } from "@/lib/artifact/sheets/model";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GRAPHE DE DÉPENDANCES D'UN CLASSEUR — précédents, dépendants, ordre de calcul, cycles.
 *
 * ── LA DIFFICULTÉ QUI COMPTE : LES PLAGES ────────────────────────────────────────────────
 *
 * Une formule =SUM(D2:D100001) dépend de cent mille cellules. Créer cent mille arêtes par total
 * multiplierait la mémoire par le nombre de totaux ; ne rien créer rendrait le graphe faux. On
 * garde la plage COMME PLAGE sur le nœud, et l'on répond à « qui dépend de D57 ? » en deux temps :
 * les arêtes directes (une Map), puis les plages qui CONTIENNENT D57 (un index par feuille, borné
 * par colonnes). C'est exact, et cela tient à cent mille lignes.
 *
 * ── L'ORDRE DE CALCUL ────────────────────────────────────────────────────────────────────
 *
 * Kahn sur les seules cellules à formule ; un cycle est DIT (les cellules qui le forment), jamais
 * contourné en silence — une référence circulaire est un défaut du classeur que l'audit nomme.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'identité d'une cellule dans le graphe : « <feuille>:<clé numérique> ». */
export type IdCellule = string;
export const idDe = (feuille: number, row: number, col: number): IdCellule => `${feuille}:${cleDe(row, col)}`;

export interface NoeudFormule {
  id: IdCellule;
  feuille: number;
  row: number;
  col: number;
  formule: string;
  /** Précédents simples (cellules) — dans la même feuille ou une autre. */
  cellules: IdCellule[];
  /** Précédents en plage. */
  plages: { feuille: number; plage: Plage }[];
  /** Noms définis utilisés (résolus par l'évaluateur, pas ici). */
  noms: string[];
  /** La formule n'a pas été lue à coup sûr : ni précédents ni évaluation, et l'audit le dit. */
  illisible: boolean;
  /** Référence vers une feuille qui n'existe pas dans le classeur. */
  feuillesInconnues: string[];
}

export interface Graphe {
  noeuds: Map<IdCellule, NoeudFormule>;
  /** Dépendants DIRECTS par cellule (arêtes issues de références simples). */
  dependants: Map<IdCellule, IdCellule[]>;
  /** Index des plages par feuille : les formules qui lisent une plage de cette feuille. */
  plagesParFeuille: Map<number, { noeud: IdCellule; plage: Plage }[]>;
  /** L'ordre topologique des formules (sans les cycles). */
  ordre: IdCellule[];
  /** Les cellules prises dans une référence circulaire. */
  cycles: IdCellule[][];
  metriques: { formules: number; aretes: number; plages: number; illisibles: number; ms: number };
}

function feuilleIndex(classeur: Classeur, nom: string | null, courante: number): number | null {
  if (nom === null) return courante;
  const cible = nom.toLowerCase();
  const f = classeur.feuilles.find((x) => x.nom.toLowerCase() === cible);
  return f ? f.index : null;
}

/** Résout les noms définis en références (Ventes!$B$2:$B$100) quand c'en sont ; les constantes restent des noms. */
export function plageDeNom(classeur: Classeur, nom: string, feuilleCourante: number): { feuille: number; plage: Plage } | null {
  const cible = nom.includes("!") ? nom.split("!").pop()!.toLowerCase() : nom.toLowerCase();
  const defini = classeur.noms.find((n) => n.nom.toLowerCase() === cible && (n.feuille === null || n.feuille === feuilleCourante))
    ?? classeur.noms.find((n) => n.nom.toLowerCase() === cible);
  if (!defini) return null;
  const arbre = analyser(defini.refersTo);
  if (!arbre || arbre.k !== "ref") return null;
  const f = feuilleIndex(classeur, arbre.ref.feuille, feuilleCourante);
  if (f === null) return null;
  return { feuille: f, plage: { r1: arbre.ref.r1, c1: arbre.ref.c1, r2: arbre.ref.r2, c2: arbre.ref.c2 } };
}

const SEUIL_PLAGE = 1;

/** Construit le graphe. Coût linéaire en nombre de formules et de références. */
export function construireGraphe(classeur: Classeur): Graphe {
  const debut = Date.now();
  const noeuds = new Map<IdCellule, NoeudFormule>();
  const dependants = new Map<IdCellule, IdCellule[]>();
  const plagesParFeuille = new Map<number, { noeud: IdCellule; plage: Plage }[]>();
  let aretes = 0; let plages = 0; let illisibles = 0;

  const lierPlage = (noeud: IdCellule, feuille: number, plage: Plage): void => {
    const liste = plagesParFeuille.get(feuille) ?? [];
    liste.push({ noeud, plage });
    plagesParFeuille.set(feuille, liste);
    plages += 1;
  };

  for (const { feuille, cellule } of formulesDe(classeur)) {
    const id = idDe(feuille.index, cellule.row, cellule.col);
    const arbre = analyser(cellule.f!);
    const noeud: NoeudFormule = { id, feuille: feuille.index, row: cellule.row, col: cellule.col, formule: cellule.f!, cellules: [], plages: [], noms: [], illisible: !arbre, feuillesInconnues: [] };
    if (arbre) {
      for (const r of referencesDe(arbre)) {
        if (r.externe) continue;
        const f = feuilleIndex(classeur, r.feuille, feuille.index);
        if (f === null) { if (r.feuille && !noeud.feuillesInconnues.includes(r.feuille)) noeud.feuillesInconnues.push(r.feuille); continue; }
        const plage: Plage = { r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2 };
        if (tailleDe(plage) <= SEUIL_PLAGE) {
          const cible = idDe(f, r.r1, r.c1);
          noeud.cellules.push(cible);
          const d = dependants.get(cible) ?? [];
          d.push(id); dependants.set(cible, d); aretes += 1;
        } else {
          noeud.plages.push({ feuille: f, plage });
          lierPlage(id, f, plage);
        }
      }
      for (const nom of nomsDe(arbre)) {
        noeud.noms.push(nom);
        const p = plageDeNom(classeur, nom, feuille.index);
        if (p) {
          if (tailleDe(p.plage) <= SEUIL_PLAGE) {
            const cible = idDe(p.feuille, p.plage.r1, p.plage.c1);
            noeud.cellules.push(cible);
            const d = dependants.get(cible) ?? []; d.push(id); dependants.set(cible, d); aretes += 1;
          } else { noeud.plages.push(p); lierPlage(id, p.feuille, p.plage); }
        }
      }
    } else {
      illisibles += 1;
    }
    noeuds.set(id, noeud);
  }

  const { ordre, cycles } = ordonner(noeuds, dependants, plagesParFeuille);
  return { noeuds, dependants, plagesParFeuille, ordre, cycles, metriques: { formules: noeuds.size, aretes, plages, illisibles, ms: Date.now() - debut } };
}

/** Les FORMULES qui dépendent directement d'une cellule : arêtes simples + plages qui la contiennent. */
export function dependantsDirects(g: Graphe, feuille: number, row: number, col: number): IdCellule[] {
  const id = idDe(feuille, row, col);
  const out = new Set<IdCellule>(g.dependants.get(id) ?? []);
  for (const { noeud, plage } of g.plagesParFeuille.get(feuille) ?? []) {
    if (contient(plage, row, col)) out.add(noeud);
  }
  return [...out];
}

/** Les précédents DIRECTS d'une formule : cellules et plages, tels qu'écrits. */
export function precedentsDirects(g: Graphe, id: IdCellule): { cellules: IdCellule[]; plages: { feuille: number; plage: Plage }[] } {
  const n = g.noeuds.get(id);
  return n ? { cellules: n.cellules, plages: n.plages } : { cellules: [], plages: [] };
}

function coordDeId(id: IdCellule): { feuille: number; row: number; col: number } {
  const [f, k] = id.split(":");
  const cle = Number(k);
  return { feuille: Number(f), row: Math.floor(cle / 16_384), col: cle % 16_384 };
}

/** LE RAYON D'IMPACT : toutes les formules qui dépendent, directement ou non, d'une cellule. */
export function rayonImpact(g: Graphe, feuille: number, row: number, col: number, max = 100_000): { formules: IdCellule[]; tronque: boolean } {
  const vus = new Set<IdCellule>();
  const file: { feuille: number; row: number; col: number }[] = [{ feuille, row, col }];
  let tronque = false;
  while (file.length > 0) {
    const c = file.shift()!;
    for (const d of dependantsDirects(g, c.feuille, c.row, c.col)) {
      if (vus.has(d)) continue;
      if (vus.size >= max) { tronque = true; break; }
      vus.add(d);
      file.push(coordDeId(d));
    }
    if (tronque) break;
  }
  return { formules: [...vus], tronque };
}

/** Kahn sur les formules : chaque formule attend ses précédents FORMULES (cellules et plages). */
function ordonner(
  noeuds: Map<IdCellule, NoeudFormule>,
  dependants: Map<IdCellule, IdCellule[]>,
  plagesParFeuille: Map<number, { noeud: IdCellule; plage: Plage }[]>,
): { ordre: IdCellule[]; cycles: IdCellule[][] } {
  // Degré entrant = nombre de précédents qui sont eux-mêmes des formules.
  const entrant = new Map<IdCellule, number>();
  const sortant = new Map<IdCellule, IdCellule[]>();
  const lier = (de: IdCellule, vers: IdCellule) => {
    if (de === vers) return;
    const s = sortant.get(de) ?? []; s.push(vers); sortant.set(de, s);
    entrant.set(vers, (entrant.get(vers) ?? 0) + 1);
  };
  for (const n of noeuds.values()) entrant.set(n.id, 0);
  for (const n of noeuds.values()) {
    for (const c of n.cellules) if (noeuds.has(c)) lier(c, n.id);
  }
  // Une formule DANS une plage lue par une autre formule précède celle-ci.
  for (const n of noeuds.values()) {
    for (const { noeud, plage } of plagesParFeuille.get(n.feuille) ?? []) {
      if (noeud !== n.id && contient(plage, n.row, n.col)) lier(n.id, noeud);
    }
  }
  const file: IdCellule[] = [];
  for (const [id, deg] of entrant) if (deg === 0) file.push(id);
  const ordre: IdCellule[] = [];
  // Une tête d'index, PAS `shift()` : sur deux cent mille formules, `shift()` recopie le tableau
  // à chaque tour et le tri devient quadratique (mesuré : 16 s au lieu de 0,3 s).
  let tete = 0;
  while (tete < file.length) {
    const id = file[tete++];
    ordre.push(id);
    for (const v of sortant.get(id) ?? []) {
      const d = (entrant.get(v) ?? 0) - 1;
      entrant.set(v, d);
      if (d === 0) file.push(v);
    }
  }
  const restants = [...entrant.entries()].filter(([, d]) => d > 0).map(([id]) => id);
  const cycles = restants.length > 0 ? [restants] : [];
  return { ordre, cycles };
}

/** Une vue lisible d'une cellule du graphe. */
export function libelleCellule(classeur: Classeur, id: IdCellule): string {
  const { feuille, row, col } = coordDeId(id);
  const f = classeur.feuilles.find((x) => x.index === feuille);
  const lettres = (n: number) => { let s = ""; let x = n; while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; };
  return `${f?.nom ?? `Feuil${feuille}`}!${lettres(col)}${row}`;
}

export const celluleDeId = coordDeId;
