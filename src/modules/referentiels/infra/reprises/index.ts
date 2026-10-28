/**
 * LES REPRISES DE LA REFONTE — la liste que l'écran Administration › Refonte des données affiche, dans l'ordre où
 * il faut les lancer : les organisations, les personnes (les adresses et coordonnées s'y rattachent), puis les
 * lieux, le rattrapage des pièces déjà déposées (enrichissement), et la copie des données sensibles au coffre
 * (après les personnes et organisations, auxquelles elle rattache chaque valeur). Un import + une ligne par reprise
 * (contrat : `types.ts`).
 *
 * Serveur seulement (chaque reprise lit la base) : l'écran client reçoit `{ cle, titre, description }`, jamais ce
 * module.
 */
import type { Reprise } from "../../domaine/reprises/types";
import { organisations } from "./organisations";
import { organisationsTextes } from "./organisations-textes";
import { organisationsAffiliations } from "./organisations-affiliations";
import { organisationsDoublons } from "./organisations-doublons";
import { reprisesPersonnes } from "./personnes";
import { repriseLieuxWilaya } from "./lieux-wilaya";
import { repriseAdresses } from "./adresses";
import { reprisePointsDeContact } from "./points-de-contact";
import { repriseRattrapagePieces } from "./rattrapage-pieces";
import { repriseCoffre } from "./coffre";

export const REPRISES: readonly Reprise[] = [
  organisations,
  organisationsTextes,
  ...reprisesPersonnes,
  organisationsAffiliations,
  organisationsDoublons,
  repriseLieuxWilaya,
  repriseAdresses,
  reprisePointsDeContact,
  repriseRattrapagePieces,
  repriseCoffre,
];

export function trouverReprise(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}

export type { BilanReprise, Reprise } from "../../domaine/reprises/types";
