import type { CelluleAnalyse, ColonneAnalyse, FormatColonne } from "@/platform/ia/workspace/analyse";

/**
 * L'AFFICHAGE D'UNE ANALYSE — pur, sans import de valeur : le serveur (aperçu du modèle) et l'écran (tableau, CSV)
 * écrivent un nombre de la MÊME façon (lot K1, décision 0031). « 12 345 678 DZD » à l'écran est le même texte que
 * celui que le modèle a reçu et cité : la personne retrouve, caractère pour caractère, le chiffre de la réponse.
 */

const NF = (max: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: max });
const NF0 = NF(0), NF1 = NF(1), NF2 = NF(2);

/** Un nombre tel qu'on le LIT (« 12 345 678 DZD », « 12,5 % »). */
export function enClair(v: CelluleAnalyse, format: FormatColonne): string {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number") {
    if (format === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
    return String(v);
  }
  switch (format) {
    case "dzd": return `${(Number.isInteger(v) ? NF0 : NF2).format(v)} DZD`;
    case "pourcent": return `${NF1.format(v)} %`;
    case "entier": return NF0.format(v);
    default: return NF2.format(v);
  }
}

export const estNumerique = (f: FormatColonne): boolean => f === "dzd" || f === "pourcent" || f === "entier" || f === "nombre";

/** Trier des lignes sur une colonne : nombres comme des nombres, textes à la française, le vide toujours à la fin. */
export function trierLignes(lignes: readonly CelluleAnalyse[][], j: number, sens: "asc" | "desc"): CelluleAnalyse[][] {
  const fr = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
  return [...lignes].sort((a, b) => {
    const x = a[j] ?? null; const y = b[j] ?? null;
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : fr.compare(String(x), String(y));
    return sens === "asc" ? c : -c;
  });
}

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Filtrer : un texte cherché dans toutes les cellules (telles qu'affichées), et une valeur exacte d'une colonne. */
export function filtrerLignes(lignes: readonly CelluleAnalyse[][], colonnes: readonly ColonneAnalyse[], texte: string, egal?: { j: number; valeur: string } | null): CelluleAnalyse[][] {
  const q = plier(texte.trim());
  return lignes.filter((r) => (!egal || String(r[egal.j] ?? "") === egal.valeur) && (!q || colonnes.some((c, j) => plier(enClair(r[j] ?? null, c.format)).includes(q))));
}

/** Les totaux des lignes VISIBLES — seulement là où le serveur a dit qu'une colonne s'additionne (`additives`). */
export function totauxDe(lignes: readonly CelluleAnalyse[][], additives: readonly boolean[]): (number | null)[] {
  return additives.map((a, j) => (a ? lignes.reduce((s, r) => s + (typeof r[j] === "number" ? (r[j] as number) : 0), 0) : null));
}

/** Le CSV : séparateur « ; » et BOM (Excel en français l'ouvre tel quel), nombres bruts au point décimal remplacé par la virgule. */
export function versCsv(colonnes: readonly ColonneAnalyse[], lignes: readonly CelluleAnalyse[][]): string {
  const champ = (v: string): string => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cellule = (v: CelluleAnalyse): string => (v === null ? "" : typeof v === "number" ? String(v).replace(".", ",") : champ(v));
  return `﻿${[colonnes.map((c) => champ(c.libelle)).join(";"), ...lignes.map((r) => colonnes.map((_, j) => cellule(r[j] ?? null)).join(";"))].join("\r\n")}\r\n`;
}
