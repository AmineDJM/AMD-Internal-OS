/**
 * LIEUX — COMPTER « PAR WILAYA » SANS NETTOYAGE MANUEL (lot V2-D, le livrable vérifiable de `refonte-vague-2.md`).
 *
 * Avant : « Alger », « ALGER », « Alger centre » et « 16 » faisaient quatre lignes d'un regroupement sur le texte.
 * Après : un `GROUP BY wilayaCode`. Ce module met les comptes en forme pour l'écran — un rang par wilaya officielle,
 * dans l'ordre des effectifs, et la part SANS code dite à côté (jamais rangée d'office dans « Autres »).
 *
 * `decoupage: "58"` ramène les onze wilayas de 2026 à leur mère, pour comparer avec un tableau antérieur.
 *
 * Module PUR.
 */
import { WILAYAS_69, type CodeWilaya } from "./normaliser";

export interface RangWilaya {
  code: CodeWilaya;
  nom: string;
  n: number;
}

export interface ParWilaya {
  rangs: RangWilaya[];
  /** Fiches dont la wilaya n'est pas (encore) lue : texte vide, ambigu, ou reprise pas lancée. */
  sansCode: number;
  total: number;
}

const PAR_CODE = new Map(WILAYAS_69.map((w) => [w.code, w]));

/** Les comptes bruts (`wilayaCode` → n, `null` pour les fiches sans code) mis en rangs. */
export function regrouperParWilaya(
  comptes: readonly { code: string | null; n: number }[],
  options: { decoupage?: "69" | "58" } = {},
): ParWilaya {
  const parCode = new Map<CodeWilaya, number>();
  let sansCode = 0;
  for (const { code, n } of comptes) {
    const w = code ? PAR_CODE.get(code) : undefined;
    if (!w) { sansCode += n; continue; }
    const cible = options.decoupage === "58" && w.mere ? w.mere : w.code;
    parCode.set(cible, (parCode.get(cible) ?? 0) + n);
  }
  const rangs = [...parCode]
    .map(([code, n]) => ({ code, nom: PAR_CODE.get(code)!.nom, n }))
    .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code));
  return { rangs, sansCode, total: rangs.reduce((s, r) => s + r.n, 0) + sansCode };
}
