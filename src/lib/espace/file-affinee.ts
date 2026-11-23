import { construireLot, parUrgence, parUrgenceLigne, type LigneLot, type Lot, type NiveauUrgence } from "./aujourdhui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE « À FAIRE MAINTENANT » AFFINÉE (recette du 23/11/2026 — « un filtre par urgence ou par
 * date, le plus récent ») — module PUR, lu par le composant client de la file.
 *
 * Un niveau d'urgence (`URGENCES`, lu sur chaque ligne par `aujourdhui.ts`), un domaine (chapeau) et un
 * ordre : le plus urgent ou le plus récent d'abord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TriFile = "urgence" | "recent";

export interface FiltreFile {
  /** `null` = toutes les urgences. */
  urgence: NiveauUrgence | null;
  /** `null` = tous les domaines (chapeaux). */
  chapeau: string | null;
  tri: TriFile;
}

/** Combien de lignes à chaque niveau d'urgence — les compteurs des puces du filtre. */
export function compterUrgences(lots: readonly Lot[]): Record<NiveauUrgence, number> {
  const c: Record<NiveauUrgence, number> = { retard: 0, urgent: 0, normal: 0 };
  for (const l of lots) for (const x of l.lignes) c[x.urgence] += 1;
  return c;
}

/** Plus récent d'abord ; ce que rien ne date ferme la liste. */
function parRecenceLigne(a: LigneLot, b: LigneLot): number {
  if (a.depuis && b.depuis) return b.depuis.localeCompare(a.depuis) || parUrgenceLigne(a, b);
  if (a.depuis) return -1;
  if (b.depuis) return 1;
  return parUrgenceLigne(a, b);
}

function parRecence(a: Lot, b: Lot): number {
  if (a.recent && b.recent) return b.recent.localeCompare(a.recent) || parUrgence(a, b);
  if (a.recent) return -1;
  if (b.recent) return 1;
  return parUrgence(a, b);
}

/**
 * LA FILE AFFINÉE — un domaine, un niveau d'urgence, un ordre (urgence ou plus récent d'abord). Les lots
 * se RECOMPOSENT sur leurs lignes gardées : « 3 paiements à régler, dont 1 en retard » ne devient pas
 * faux sous le filtre « Urgent ». Une ligne « reste » (`suite`) ne suit que la vue complète : elle ne
 * dit pas son urgence.
 */
export function affinerFile(lots: readonly Lot[], f: FiltreFile): Lot[] {
  const gardes: Lot[] = [];
  for (const lot of lots) {
    if (f.chapeau && lot.chapeau !== f.chapeau) continue;
    if (!f.urgence) { gardes.push(lot); continue; }
    const lignes = lot.lignes.filter((l) => l.urgence === f.urgence);
    if (lignes.length === 0) continue;
    const refait = construireLot({ id: lot.id, nature: lot.nature, module: lot.module, lignes, suite: null });
    if (refait) gardes.push(refait);
  }
  if (f.tri === "recent") {
    return gardes
      .map((l) => ({ ...l, lignes: [...l.lignes].sort(parRecenceLigne) }))
      .sort(parRecence);
  }
  return gardes.sort(parUrgence);
}
