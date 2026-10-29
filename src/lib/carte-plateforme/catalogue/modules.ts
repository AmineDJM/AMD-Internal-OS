/**
 * LA CARTE DE LA PLATEFORME — les MODULES, recomposés dans l'ordre du menu (Pilotage, Pôles,
 * Transverse, Système, Externe) à partir de leurs deux moitiés.
 */
import type { ModulePlateforme } from "./types";
import { MODULES_PILOTAGE_ET_MARKETING } from "./modules-pilotage-et-marketing";
import { MODULES_TERRAIN_ET_ADMINISTRATION } from "./modules-terrain-et-administration";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES MODULES
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const MODULES_PLATEFORME: readonly ModulePlateforme[] = [
  ...MODULES_PILOTAGE_ET_MARKETING,
  ...MODULES_TERRAIN_ET_ADMINISTRATION,
];
