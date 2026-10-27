import { repriseCoffre } from "./coffre";
import type { Reprise } from "./types";

/**
 * LES REPRISES DE LA REFONTE (vague 2) — une ligne par reprise, dans l'ordre où l'écran les présente.
 * Serveur seulement (chaque reprise lit et écrit la base). Contrat : `types.ts`.
 */
export const REPRISES: readonly Reprise[] = [
  repriseCoffre,
];

export function repriseParCle(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}
