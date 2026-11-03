import type { DepsProgramme } from "@/lib/missions/equipe/conduite";
import { portsDevBranches } from "@/lib/missions/chantiers/ports-dev";
import { integrateur } from "@/lib/missions/equipe/integrateur";

/**
 * LA PORTE DES PROGRAMMES (lot O2, décision 0059) pour le battement (`scheduled.ts`) : le balayage et les dépendances
 * RÉELLES — la file d'intégration branchée sur la forge des connecteurs (GitHub), l'agent des travailleurs (
 * les sessions cloud seulement). Sans forge d'intégration, les tâches vertes restent
 * en file, et c'est dit au tableau.
 */
export { balayerProgrammes } from "@/lib/missions/equipe/conduite";

export function depsProgrammeReelles(): DepsProgramme {
  const p = portsDevBranches();
  return p?.integration ? { integrer: integrateur(p.integration, p.agent) } : {};
}
