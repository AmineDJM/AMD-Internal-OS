import type { Reprise } from "./types";
import { organisations } from "./organisations";
import { organisationsTextes } from "./organisations-textes";
import { organisationsAffiliations } from "./organisations-affiliations";
import { organisationsDoublons } from "./organisations-doublons";

/**
 * LES REPRISES DE LA REFONTE, dans l'ordre où le Super Admin les lance (Administration › Refonte des données).
 * Une reprise = un import + une ligne ; le contrat est `types.ts`.
 */
export const REPRISES: readonly Reprise[] = [
  organisations,
  organisationsTextes,
  organisationsAffiliations,
  organisationsDoublons,
];

export function trouverReprise(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}
