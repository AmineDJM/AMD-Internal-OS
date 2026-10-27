/**
 * LE REGISTRE DES REPRISES (refonte des données, vague 2) — l'écran `Administration › Refonte des données`
 * et l'action `refonte-reprise-actions.ts` ne connaissent que cette liste. Un lot = un import + une ligne.
 */

import type { Reprise } from "@/lib/referentiels/reprises/types";
import { reprisesPersonnes } from "@/lib/referentiels/reprises/personnes";

export const REPRISES: readonly Reprise[] = [
  ...reprisesPersonnes,
];

export function repriseParCle(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}
