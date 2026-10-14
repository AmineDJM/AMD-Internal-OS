/**
 * LA CATÉGORIE COMPREND SES SOUS-CATÉGORIES.
 *
 * Une sous-catégorie est une répartition À L'INTÉRIEUR de sa catégorie parente : ce qu'elle consomme,
 * la parente le consomme aussi. La requête (`queries/budget.ts`) rend la consommation PROPRE de chaque
 * nœud (aucun double compte dans le total d'enveloppe) ; l'écran, lui, affiche la parente CUMULÉE —
 * sinon « Masse salariale » montrait 7,5 M consommés alors que sa sous-catégorie en portait 11,2 M de plus.
 *
 * Module PUR, sans aucun import : lu par l'écran client.
 */

export interface NoeudCategorie {
  id: string;
  parentId: string | null;
  allocated: number;
  consumed: number;
  committed: number;
}

export type SanteCumulee = "ON_TRACK" | "AT_RISK" | "OVER_BUDGET" | "NONE";

export interface Cumul {
  consumed: number;
  committed: number;
  remaining: number;
  pct: number;
  health: SanteCumulee;
}

/** Mêmes seuils que la requête : 80 % = à surveiller, 100 % = dépassé. */
export function santeCumulee(allocated: number, consumed: number): SanteCumulee {
  if (allocated <= 0) return "NONE";
  const r = consumed / allocated;
  if (r >= 1) return "OVER_BUDGET";
  if (r >= 0.8) return "AT_RISK";
  return "ON_TRACK";
}

/**
 * Pour chaque catégorie : sa consommation (et son engagé) + ceux de TOUTES ses descendantes, à toute
 * profondeur. L'alloué reste celui de la catégorie (les sous-allocations en sont une répartition).
 * Une boucle parent ↔ enfant (donnée corrompue) est coupée : chaque nœud n'est compté qu'une fois.
 */
export function cumulerSousCategories(cats: readonly NoeudCategorie[]): Map<string, Cumul> {
  const ids = new Set(cats.map((c) => c.id));
  const enfants = new Map<string, NoeudCategorie[]>();
  for (const c of cats) {
    if (c.parentId && ids.has(c.parentId) && c.parentId !== c.id) {
      enfants.set(c.parentId, [...(enfants.get(c.parentId) ?? []), c]);
    }
  }
  const out = new Map<string, Cumul>();
  for (const c of cats) {
    let consumed = 0;
    let committed = 0;
    const vus = new Set<string>();
    const pile: NoeudCategorie[] = [c];
    while (pile.length) {
      const n = pile.pop()!;
      if (vus.has(n.id)) continue;
      vus.add(n.id);
      consumed += n.consumed;
      committed += n.committed;
      pile.push(...(enfants.get(n.id) ?? []));
    }
    out.set(c.id, {
      consumed,
      committed,
      remaining: c.allocated - consumed,
      pct: c.allocated > 0 ? Math.round((consumed / c.allocated) * 100) : 0,
      health: santeCumulee(c.allocated, consumed),
    });
  }
  return out;
}
