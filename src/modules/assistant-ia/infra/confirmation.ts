import type { CurrentUser } from "@/lib/session";
import { executerIntention, type ResultatExecution } from "@/platform/ia/intentions/action-intents";
import { estChargeOperationIA } from "../domaine/operations/types";
import { estChargeCapacite } from "../domaine/capacites";
import { executerOperationJournalisee } from "./operations";
import { corrigerCarteCapacite, executerCapacite } from "./capacites";
import { accesAssistantIa, verifierReperesAvantExecution } from "./role-config";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONFIRMATION D'UNE CARTE DE L'ASSISTANT IA — UNE seule garde, que la personne signe au BOUTON
 * (`confirmerIntentionAssistantIA`, action de l'écran) ou À L'ORAL (décision 0038, `voix/carte-orale.ts`).
 *
 * Jamais de payload reçu : seulement une intention que CE compte a préparée. Une correction du formulaire (J11)
 * repasse d'abord par les portes de la proposition (`corrigerCarteCapacite`) ; puis `executerIntention` (ressaisie
 * d'une carte renforcée vérifiée par le serveur, réclamation atomique, idempotence) appelle l'exécuteur de
 * l'Assistant IA : ses opérations, ou les CAPACITÉS de l'ERP (arrêt d'urgence, porte, famille de la console relus).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function confirmerCarte(
  user: CurrentUser, intentId: string, confirmTyped?: string, corrections?: string,
): Promise<ResultatExecution> {
  if (typeof intentId !== "string" || !intentId) return { ok: false, error: "Action introuvable." };
  if (typeof corrections === "string" && corrections) {
    let saisie: unknown;
    try { saisie = JSON.parse(corrections); } catch { return { ok: false, error: "Formulaire illisible. Rien n'a été exécuté." }; }
    const c = await corrigerCarteCapacite(user, intentId, saisie, await accesAssistantIa(user));
    if (!c.ok) return { ok: false, error: c.error };
  }
  const executeur = async (stored: unknown): Promise<ResultatExecution> => {
    // Une valeur confidentielle substituée dans la carte (décision 0012) est rejugée pour qui confirme, maintenant.
    const reperes = (stored as { reperesSubstitues?: unknown } | null)?.reperesSubstitues;
    if (Array.isArray(reperes) && reperes.length) {
      const refus = await verifierReperesAvantExecution(user, reperes, (stored as { title?: string }).title ?? "carte de l'Assistant IA");
      if (refus) return { ok: false, error: refus };
    }
    // J7 : chaque geste confirmé va au JOURNAL DES EFFETS (valeur avant de chaque champ) — il devient annulable.
    if (estChargeOperationIA(stored)) return executerOperationJournalisee(user, stored, { origine: "carte", cle: intentId });
    if (estChargeCapacite(stored)) return executerCapacite(user, stored, await accesAssistantIa(user), intentId);
    return { ok: false, error: "Cette carte a été préparée avant une mise à jour de l'assistant : redemandez-la, puis confirmez la nouvelle carte. Rien n'a été exécuté." };
  };
  return (await executerIntention(user, intentId, confirmTyped, executeur)) ?? { ok: false, error: "Action introuvable." };
}
