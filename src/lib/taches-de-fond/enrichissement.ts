import { ignoree, type TacheIgnoree } from "./executer";

/**
 * LE BRANCHEMENT DE LA FILE D'ENRICHISSEMENT (lot V2-A) — prévu ici, livré là-bas.
 *
 * La file persistante d'enrichissement (dépôt → classement → extraction → faits proposés) est le
 * travail lourd que le worker existe pour sortir du processus web. Le lot V2-A la livre sous la
 * forme `traiterLaFile({ max })` ; sa place dans la table des tâches (`enrichissement.file`, dans
 * `scheduled.ts`) existe dès maintenant, mesurée et visible au Diagnostic comme « ignorée ».
 *
 * À la livraison de V2-A, le corps ci-dessous devient — et rien d'autre ne change :
 *
 *     const { traiterLaFile } = await import("@/lib/enrichissement/file");
 *     await traiterLaFile({ max: LOT_FILE_ENRICHISSEMENT });
 *
 * (Import à l'appel, comme les routines de l'Assistant : la chaîne d'extraction ne pèse que si
 * elle sert.) Le chemin exact du module est celui que V2-A retiendra.
 */

/** Pièces traitées par passage : borné, pour que le passage suivant ne prenne pas de retard. */
export const LOT_FILE_ENRICHISSEMENT = 20;

export async function traiterFileEnrichissement(): Promise<TacheIgnoree | void> {
  return ignoree("file d'enrichissement non livrée (lot V2-A)");
}
