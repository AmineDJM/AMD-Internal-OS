import { getCurrentUser } from "@/lib/session";
import { etatDuGeste } from "./magasin";
import { journaliserGeste } from "./journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE ACTION MÉTIER RÉVERSIBLE (K10c, décision 0044) — le journal des effets J7, au clic de l'ÉCRAN aussi.
 *
 * Jusqu'ici seuls les gestes de l'assistant entraient au journal. Une action rendue réversible enveloppe son corps :
 *
 *   export async function decideValidation(fd: FormData) {
 *     return actionReversible("validation-actions:decideValidation", "Décision de validation", async () => { … });
 *   }
 *
 * Au clic : le corps s'exécute sous `journaliserGeste` (origine « ecran ») — chaque écriture garde sa ligne avant,
 * chaque effet externe son passage — et le résultat porte `annulable: { gesteId }` : l'écran montre « Annuler ».
 * Appelée par l'assistant (carte confirmée, travail, mandat), elle est DÉJÀ sous le journal du geste qui la porte :
 * rien ne change, ses écritures vont à ce geste. En simulation, rien n'est journalisé (la transaction est annulée).
 * Sans personne connectée (tâche de fond), le corps s'exécute tel quel.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La personne de la requête — `null` sans session (tâche de fond) ou quand la session ne la fournit pas (banc). */
async function personneConnectee() {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}

export interface Annulable { gesteId: string; libelle: string }

export async function actionReversible<T>(capaciteId: string, libelle: string, corps: () => Promise<T>): Promise<T> {
  if (etatDuGeste()?.capture || etatDuGeste()?.mode === "SIMULATION") return corps();
  const user = await personneConnectee();
  if (!user) return corps();
  // La personne est FIXÉE au début du geste (`personneFixee` : `requireUser` la rend telle quelle pendant tout le corps) —
  // celle que la session donnait à l'instant du clic, jamais relue après un `await`.
  const { resultat, gesteId } = await journaliserGeste(user, { origine: "ecran", capaciteId, libelle }, corps, { personneFixee: true });
  if (gesteId && resultat && typeof resultat === "object" && !Array.isArray(resultat) && (resultat as { ok?: unknown }).ok !== false) {
    return { ...(resultat as object), annulable: { gesteId, libelle } satisfies Annulable } as T;
  }
  return resultat;
}
