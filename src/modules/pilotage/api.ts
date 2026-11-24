/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE PILOTAGE — LA PORTE SERVEUR (lot « mémoire », 24/11/2026) : les signaux datés, la mémoire de ce que les IA
 * produisent et de ce que les humains en font.
 *
 *   • écrire — `ecrireSignaux`, `noterProposition`, `noterDecision` (aussi par la porte étroite `api-ecriture.ts`) ;
 *   • lire — `lireSignaux`, `lireTauxAcceptation` : SUPER ADMIN SEUL pour l'instant ;
 *   • l'instantané quotidien des finances par société — `instantaneQuotidienSiDu` (tâche `pilotage.instantane`) ;
 *   • les clés orphelines — `repointerInfluence` (la fusion de deux fiches médecin), `controlerCles` (l'existant) ;
 *   • les dimensions dérivées — `dimensionsDesVisites` (L3), `wilayasParDr` (L9).
 *
 * Table possédée : `SignalDate` (migration `20270247900000_signaux_dates`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { sansBloquer } from "@/lib/journal";
import { controlerCles } from "./infra/cles";
import { instantaneFinances } from "./infra/finances";
import { jourAlger } from "./domaine/signaux";

// La porte pure ET les écrivains (`api-ecriture` réexporte `partage`).
export * from "./api-ecriture";
export { REFUS_SIGNAUX, lireSignaux, lireTauxAcceptation, peutLireSignaux, type FiltreSignaux, type SignalLu } from "./infra/lecture";
export { instantaneFinances, type BilanInstantane } from "./infra/finances";
export { controlerCles, repointerInfluence, type BilanControle, type BilanRepointage } from "./infra/cles";
export { dimensionsDesVisites, wilayasParDr } from "./infra/dimensions";

let dernierJour: string | null = null;

/**
 * La tâche de fond `pilotage.instantane` : une fois par jour et par exécutant — l'instantané des finances, puis le
 * contrôle des clés en LECTURE (il signale ; la correction se lance à la main, `scripts/controle-cles-orphelines.ts`).
 * Idempotente de toute façon : un second passage le même jour réécrit les mêmes lignes.
 */
export async function instantaneQuotidienSiDu(maintenant = new Date()): Promise<void> {
  const jour = jourAlger(maintenant);
  if (dernierJour === jour) return;
  dernierJour = jour;
  await instantaneFinances(maintenant).catch(sansBloquer("pilotage.instantane.finances"));
  await controlerCles({ corriger: false, maintenant }).catch(sansBloquer("pilotage.instantane.cles"));
}
