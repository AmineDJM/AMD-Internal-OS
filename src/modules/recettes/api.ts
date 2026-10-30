/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE RECETTES — LA PORTE SERVEUR (J10, décision 0028) : la mémoire procédurale de la maison.
 *
 *   • `proposerLesRecettes` — lit les circuits réels, PROPOSE (jamais sous le seuil d'occurrences) ;
 *   • `lireEcranRecettes` — l'écran « Recettes », sous la règle de visibilité du circuit ;
 *   • `validerVersion`, `corrigerEtValider`, `rejeterVersion`, `retirerRecette` — le responsable du processus seul ;
 *   • `designerResponsable` — la Direction ;
 *   • `recettePour` — l'assistant : la version VALIDÉE ou rien, avec son plan et ses écarts.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { proposerLesRecettes } from "./infra/extraction";

export * from "./partage";
export { proposerLesRecettes, type BilanExtraction } from "./infra/extraction";
export {
  corrigerEtValider, designerResponsable, lireEcranRecettes, recettePour, rejeterVersion, retirerRecette, statsUsages, validerVersion, voitDesRecettes, voitLeCircuit,
  type EcranRecettes, type RecetteLue, type ReponseRecette, type StatsUsage, type VersionLue,
} from "./infra/recettes";

let dernierJour: string | null = null;

/** La tâche de fond `recettes.extraction` : un passage par jour et par exécutant (idempotent de toute façon). */
export async function proposerLesRecettesSiDu(maintenant = new Date()): Promise<void> {
  const jour = maintenant.toISOString().slice(0, 10);
  if (dernierJour === jour) return;
  dernierJour = jour;
  await proposerLesRecettes({ maintenant });
}
