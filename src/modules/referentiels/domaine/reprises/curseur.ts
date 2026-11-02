/**
 * LE CURSEUR D'UNE REPRISE À PLUSIEURS SOURCES — `"<source>:<dernier id>"`, ou `"<source>:"` pour le début d'une
 * source. Un lot ne lit qu'UNE source (le lot qui finit une table est donc parfois plus court que `taille`) : le
 * curseur reste lisible dans le journal (« MedicalDoctor:ckx… ») et une reprise interrompue repart là où elle était.
 *
 * Module PUR.
 */
import type { BilanReprise } from "./types";

export interface Position<S extends string> {
  source: S;
  apresId: string | null;
}

/** La position désignée par le curseur ; `null`/vide = le début de la première source. Un curseur inconnu est refusé. */
export function lireCurseur<S extends string>(curseur: string | null | undefined, sources: readonly S[]): Position<S> {
  if (!curseur) return { source: sources[0], apresId: null };
  const i = curseur.indexOf(":");
  const source = (i < 0 ? curseur : curseur.slice(0, i)) as S;
  if (!sources.includes(source)) throw new Error(`Curseur de reprise illisible : « ${curseur} ».`);
  const id = i < 0 ? "" : curseur.slice(i + 1);
  return { source, apresId: id || null };
}

/**
 * Le curseur du lot suivant : la même source après `dernierId` si le lot était plein, sinon le début de la source
 * suivante — `null` quand la dernière source est épuisée.
 */
export function curseurSuivant<S extends string>(
  sources: readonly S[],
  source: S,
  lus: readonly { id: string }[],
  taille: number,
): string | null {
  if (lus.length >= taille && lus.length > 0) return `${source}:${lus[lus.length - 1].id}`;
  const suivante = sources[sources.indexOf(source) + 1];
  return suivante ? `${suivante}:` : null;
}

export function bilanVide(): BilanReprise {
  return { lues: 0, creees: 0, liees: 0, doublonsProposes: 0, ignorees: 0, erreurs: [] };
}

/** Additionne deux bilans (aperçu source par source). Les erreurs sont plafonnées à `maxErreurs`, le reste compté. */
export function cumuler(a: BilanReprise, b: BilanReprise, maxErreurs = 200): BilanReprise {
  const erreurs = [...a.erreurs, ...b.erreurs];
  return {
    lues: a.lues + b.lues,
    creees: a.creees + b.creees,
    liees: a.liees + b.liees,
    doublonsProposes: a.doublonsProposes + b.doublonsProposes,
    ignorees: a.ignorees + b.ignorees,
    erreurs: erreurs.length > maxErreurs ? erreurs.slice(0, maxErreurs) : erreurs,
  };
}
