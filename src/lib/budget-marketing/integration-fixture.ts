/**
 * UNE FEUILLE SYNTHÉTIQUE AU FORMAT DU FICHIER « Dépenses AP » — pour les tests (jamais le fichier réel, qui ne se
 * commite pas). Elle porte les en-têtes de la ligne 4, les lignes décidées telles que la Direction les a vues, la ligne
 * écartée (consulting) et des lignes budgétées sans dépense. Module PUR, sans import lourd.
 */
import { DECISIONS_LIGNES, LIGNES_ECARTEES, type LigneLue } from "./integration-2026";

export type Cellules = (string | number | null)[][];


/** Les cellules de Feuil1 (ligne 1 = index 0), modifiables avant d'écrire le classeur. */
export function cellulesSynthetiques(): Cellules {
  const rows: Cellules = Array.from({ length: 62 }, () => Array.from({ length: 9 }, () => null));
  rows[2] = ["Total DZD AD&PRO", "Total DZD", null, null, null, 38_696_105, 36_571_716.07, null, null];
  rows[3] = ["ACTION", "ACTION", "DETAIL ACTION", "Lieux", "MOIS ", "TOTAL BUDGET ", "Depenses Reelles", "D", "Commentaires"];
  for (const d of DECISIONS_LIGNES) {
    const mois = d.moisFichier === null ? null : d.moisFichier[0].toUpperCase() + d.moisFichier.slice(1);
    rows[d.ligne - 1] = ["Action", "Sous-action", d.detailFichier, null, mois, 100_000, d.depenseFichier, null, null];
  }
  for (const e of LIGNES_ECARTEES) rows[e.ligne - 1] = ["Consultant/Trainer", "Consulting", e.detailFichier, null, null, 1_800_000, e.depenseFichier, null, "A reallouer RH"];
  // Des lignes budgétées sans dépense réelle (elles n'entrent pas).
  for (const l of [6, 8, 26, 27, 29, 31, 33, 34, 35, 36, 41, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 59]) {
    rows[l - 1] = ["Action", "Sous-action", `Ligne budgétée ${l}`, null, null, 50_000, l % 2 ? 0 : null, null, null];
  }
  return rows;
}

/** Les lignes lues d'une feuille synthétique — sans passer par un classeur. */
export function lignesSynthetiques(cellules: Cellules = cellulesSynthetiques()): LigneLue[] {
  const out: LigneLue[] = [];
  for (let n = 5; n <= 59; n++) {
    const r = cellules[n - 1] ?? [];
    const t = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
    out.push({ ligne: n, actionA: t(r[0]), actionB: t(r[1]), detail: t(r[2]), lieux: t(r[3]), mois: t(r[4]), budget: typeof r[5] === "number" ? r[5] : null, depense: typeof r[6] === "number" ? r[6] : null, commentaire: t(r[8]) });
  }
  return out;
}
