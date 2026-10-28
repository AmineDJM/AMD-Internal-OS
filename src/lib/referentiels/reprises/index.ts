/**
 * LES REPRISES DE LA REFONTE — la liste que l'écran Administration › Refonte des données affiche, dans l'ordre où
 * il faut les lancer. Un import + une ligne par reprise (contrat : `types.ts`).
 *
 * Serveur seulement (chaque reprise lit la base) : l'écran client reçoit `{ cle, titre, description }`, jamais ce
 * module.
 */
import type { Reprise } from "./types";
import { repriseLieuxWilaya } from "./lieux-wilaya";
import { repriseAdresses } from "./adresses";
import { reprisePointsDeContact } from "./points-de-contact";

export const REPRISES: readonly Reprise[] = [
  repriseLieuxWilaya,
  repriseAdresses,
  reprisePointsDeContact,
];

export function trouverReprise(cle: string): Reprise | null {
  return REPRISES.find((r) => r.cle === cle) ?? null;
}
