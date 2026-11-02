import type { TacheIgnoree } from "./executer";

/**
 * LE BRANCHEMENT DE LA FILE D'ENRICHISSEMENT (lot V2-A) dans la table des tâches (`enrichissement.file`).
 *
 * Dépôt → classement → extraction → faits proposés : le travail lourd que le worker existe pour sortir du
 * processus web. `traiterLaFile` ne fait rien tant que l'interrupteur `enrichissementActif` est fermé
 * (Administration › Refonte des données). Import à l'appel : la chaîne d'extraction ne pèse que si elle sert.
 */

/** Pièces traitées par passage : borné, pour que le passage suivant ne prenne pas de retard. */
export const LOT_FILE_ENRICHISSEMENT = 20;

export async function traiterFileEnrichissement(): Promise<TacheIgnoree | void> {
  const { traiterLaFile } = await import("@/lib/enrichissement/traitement");
  await traiterLaFile({ max: LOT_FILE_ENRICHISSEMENT });
}
