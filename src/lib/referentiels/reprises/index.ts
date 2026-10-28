/**
 * LES REPRISES DE LA REFONTE — la liste que l'écran Administration › Refonte des données affiche, dans l'ordre où
 * il faut les lancer : les organisations d'abord (les adresses et coordonnées s'y rattachent), puis les lieux.
 * Un import + une ligne par reprise (contrat : `types.ts`).
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

export const REPRISES: readonly Reprise[] = [
  organisations,
  organisationsTextes,
  organisationsAffiliations,
  organisationsDoublons,
  repriseLieuxWilaya,
  repriseAdresses,
  reprisePointsDeContact,
];

export function trouverReprise(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}
