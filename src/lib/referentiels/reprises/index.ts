import type { Reprise } from "./types";
import { repriseRattrapagePieces } from "./rattrapage-pieces";

/**
 * LA LISTE DES REPRISES — un import et une ligne par reprise (contrat commun de la vague 2). L'écran
 * Administration › Refonte des données en montre une carte chacune. Serveur seulement.
 */
export const REPRISES: readonly Reprise[] = [
  repriseRattrapagePieces,
];

export function repriseParCle(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}

export type { BilanReprise, Reprise } from "./types";
