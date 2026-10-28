/**
<<<<<<< HEAD
 * LES REPRISES DE LA REFONTE — la liste que l'écran Administration › Refonte des données affiche, dans l'ordre où
 * il faut les lancer : les organisations, les personnes (les adresses et coordonnées s'y rattachent), puis les lieux, puis
 * le rattrapage des pièces déjà déposées (enrichissement). Un import + une ligne par reprise (contrat : `types.ts`).
 *
 * Serveur seulement (chaque reprise lit la base) : l'écran client reçoit `{ cle, titre, description }`, jamais ce
 * module.
 */
import type { Reprise } from "./types";
import { organisations } from "./organisations";
import { organisationsTextes } from "./organisations-textes";
import { organisationsAffiliations } from "./organisations-affiliations";
import { organisationsDoublons } from "./organisations-doublons";
import { repriseLieuxWilaya } from "./lieux-wilaya";
import { repriseAdresses } from "./adresses";
import { reprisePointsDeContact } from "./points-de-contact";
import { repriseRattrapagePieces } from "./rattrapage-pieces";
import { reprisesPersonnes } from "./personnes";

export const REPRISES: readonly Reprise[] = [
  organisations,
  organisationsTextes,
  organisationsAffiliations,
  organisationsDoublons,
  ...reprisesPersonnes,
  repriseLieuxWilaya,
  repriseAdresses,
  reprisePointsDeContact,
  repriseRattrapagePieces,
];

export function trouverReprise(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}

export type { BilanReprise, Reprise } from "./types";
=======
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
>>>>>>> origin/refonte/v2-personnes
