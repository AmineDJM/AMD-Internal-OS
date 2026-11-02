import { cleDe } from "@/lib/artifact/sheets/refs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODÈLE D'ANALYSE D'UN CLASSEUR — fait pour deux millions de cellules, pas pour l'écran.
 *
 * Live Office (`object-model/model.ts`) modélise ce que la personne VOIT et modifie, borné à
 * vingt mille cellules par feuille parce que l'écran les rend une à une. Ce modèle-ci sert à
 * RAISONNER : graphe de dépendances, recalcul, audit, comparaison. Il ne porte que ce qui compte
 * pour cela (valeur, type, formule, format de nombre) et range les cellules dans une Map à clé
 * numérique — le choix qui fait la différence entre « tient en mémoire » et « ne tient pas »
 * à cent mille lignes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TypeCellule = "n" | "s" | "b" | "e" | "d" | "vide";

export interface Cellule {
  row: number;
  col: number;
  /** La valeur AFFICHÉE (mise en cache par Excel) — nombre, texte, booléen, code d'erreur, ou null. */
  v: number | string | boolean | null;
  t: TypeCellule;
  /** La formule, sans le signe égal. `null` pour une constante. */
  f: string | null;
  /** Le format de nombre, quand le lecteur l'a vu (les dates se reconnaissent par lui). */
  numFmt?: string | null;
}

export interface Feuille {
  index: number;
  nom: string;
  cellules: Map<number, Cellule>;
  /** Bornes observées : la dernière ligne et la dernière colonne non vides. */
  lignes: number;
  colonnes: number;
  masquee?: boolean;
}

export interface NomDefini {
  nom: string;
  /** La référence telle qu'écrite (« Ventes!$B$2:$B$100 », ou une constante). */
  refersTo: string;
  /** Portée locale (index de feuille) ou globale (null). */
  feuille: number | null;
}

export interface Classeur {
  feuilles: Feuille[];
  noms: NomDefini[];
  /** Ce que le lecteur n'a pas pu modéliser — dit, jamais tu. */
  limites: string[];
}

export function nouvelleFeuille(index: number, nom: string): Feuille {
  return { index, nom, cellules: new Map(), lignes: 0, colonnes: 0 };
}

export function poserCellule(f: Feuille, c: Cellule): void {
  f.cellules.set(cleDe(c.row, c.col), c);
  if (c.row > f.lignes) f.lignes = c.row;
  if (c.col > f.colonnes) f.colonnes = c.col;
}

export const lireCellule = (f: Feuille, row: number, col: number): Cellule | undefined => f.cellules.get(cleDe(row, col));

export function feuilleParNom(classeur: Classeur, nom: string | null | undefined, defaut?: Feuille): Feuille | undefined {
  if (!nom) return defaut ?? classeur.feuilles[0];
  const cible = nom.trim().toLowerCase();
  return classeur.feuilles.find((f) => f.nom.toLowerCase() === cible);
}

/** Les cellules qui portent une formule, dans l'ordre (feuille, ligne, colonne). */
export function* formulesDe(classeur: Classeur): Generator<{ feuille: Feuille; cellule: Cellule }> {
  for (const feuille of classeur.feuilles) {
    const cles = [...feuille.cellules.keys()].sort((a, b) => a - b);
    for (const k of cles) {
      const c = feuille.cellules.get(k)!;
      if (c.f) yield { feuille, cellule: c };
    }
  }
}
