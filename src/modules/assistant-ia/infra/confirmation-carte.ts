import type { CurrentUser } from "@/lib/session";
import { executerIntention, type ResultatExecution } from "@/platform/ia/intentions/action-intents";
import { estChargeOperationIA } from "../domaine/operations/types";
import { estChargeCapacite } from "../domaine/capacites";
import { executerOperationJournalisee } from "./operations";
import { corrigerCarteCapacite, executerCapacite } from "./capacites";
import { accesAssistantIa, verifierReperesAvantExecution } from "./role-config";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONFIRMATION D'UNE CARTE DE L'ASSISTANT — UNE seule porte, pour le bouton de l'écran ET pour le « vas-y » oral
 * (lot K9, décision 0038). L'appelant a déjà établi QUI confirme (session de l'écran, ou session vocale vérifiée) ;
 * ici : la correction du formulaire (J11), la ressaisie critique, la réclamation atomique, le journal des effets (J7).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function confirmerIntentionDe(user: CurrentUser, intentId: string, confirmTyped?: string, corrections?: string): Promise<ResultatExecution> {
  // J11 (décision 0030) : la personne a CORRIGÉ le formulaire de la carte — la correction repasse par les portes de
  // la proposition et réécrit la carte (ressaisie comprise) AVANT la confirmation ordinaire, qui n'en sait rien.
  // L'entrée corrigée voyage en JSON (`corrections`) : le contrat de l'action reste lisible (trois textes).
  if (typeof corrections === "string" && corrections) {
    let saisie: unknown;
    try { saisie = JSON.parse(corrections); } catch { return { ok: false, error: "Formulaire illisible. Rien n'a été exécuté." }; }
    const c = await corrigerCarteCapacite(user, intentId, saisie, await accesAssistantIa(user));
    if (!c.ok) return { ok: false, error: c.error };
  }
  const executeur = async (stored: unknown) => {
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
