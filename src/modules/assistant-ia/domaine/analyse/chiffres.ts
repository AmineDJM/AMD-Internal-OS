import { nombresDe } from "../ui/composants";

/**
 * LES CHIFFRES DU TEXTE QUE RIEN NE PROUVE (lot K1, décision 0031) — le garde-fou de l'UI générative étendu au
 * MESSAGE d'un tour d'analyse.
 *
 * Le tableau et le graphique d'une analyse sont composés par le code ; le message, lui, est écrit par le modèle.
 * Chaque nombre qu'il cite doit se retrouver dans ce que les outils du tour ont rendu (ou la question) — à l'arrondi
 * d'affichage près (« 12,3 % » pour 12,34 ; « 1 234 568 » pour 1 234 567,8). Ce qui ne se retrouve pas est COMPTÉ :
 * le tour le dit sous la réponse, et le banc le mesure (objectif : zéro).
 *
 * Pur.
 */

/** Petits entiers (rangs, comptes, mois), années : pas des données à prouver. */
const libre = (v: number): boolean => (Number.isInteger(v) && Math.abs(v) <= 12) || (Number.isInteger(v) && v >= 1990 && v <= 2100);

const decimales = (texte: string): number => {
  const m = /[.,](\d+)$/.exec(texte);
  return m ? m[1].length : 0;
};

/** Le nombre du texte (tel qu'écrit) se retrouve-t-il dans les sources, à l'arrondi d'affichage près ? */
function prouve(ecrit: string, v: number, sources: ReadonlySet<number>, triees: readonly number[]): boolean {
  if (libre(v) || sources.has(v)) return true;
  const d = decimales(ecrit);
  const tol = 0.5 * 10 ** -d + 1e-9;
  // Recherche dichotomique du voisin le plus proche.
  let lo = 0, hi = triees.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (triees[m] < v) lo = m + 1; else hi = m; }
  return [triees[lo - 1], triees[lo]].some((s) => s !== undefined && Math.abs(s - v) <= tol);
}

const RE_ECRIT = /\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

export function chiffresNonSources(message: string, sources: readonly string[]): string[] {
  const connus = new Set(nombresDe(sources.join("\n")));
  const triees = [...connus].sort((a, b) => a - b);
  const out: string[] = [];
  // Les repères ⟦S1⟧ et les dates ISO ne sont pas des chiffres cités.
  const texte = (message ?? "").replace(/⟦S\d+⟧/g, " ").replace(/\b\d{4}-\d{2}(-\d{2})?\b/g, " ").replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, " ");
  for (const m of texte.matchAll(RE_ECRIT)) {
    const v = Number(m[0].replace(/[ \u00a0\u202f]/g, "").replace(",", "."));
    if (Number.isFinite(v) && !prouve(m[0], v, connus, triees)) out.push(m[0]);
  }
  return [...new Set(out)];
}

/** La note sous la réponse quand des chiffres du texte ne se retrouvent pas dans les calculs du tour. */
export function noteChiffresNonSources(message: string, sources: readonly string[]): { chiffres: string[]; texte: string } | null {
  const chiffres = chiffresNonSources(message, sources);
  if (!chiffres.length) return null;
  return { chiffres, texte: `_À vérifier : ${chiffres.length === 1 ? `le chiffre ${chiffres[0]} du texte ne vient` : `${chiffres.length} chiffres du texte (${chiffres.slice(0, 4).join(", ")}) ne viennent`} pas des calculs affichés — seuls le tableau et le graphique font foi._` };
}
