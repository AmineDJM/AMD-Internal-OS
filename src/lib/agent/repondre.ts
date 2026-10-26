import { Agent } from "@mastra/core/agent";
import type { AssistantRoleConfig } from "@prisma/client";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { outilsPour } from "@/lib/agent/outils";
import type { ModeleConfig } from "@/lib/agent/modele";

/**
 * UN TOUR DE L'ASSISTANT — avec délai, et secours si plusieurs modèles sont configurés (aujourd'hui : MiMo seul).
 *
 * Chaque modèle a un délai : au-delà, ou sur une erreur (réseau, appel d'outil invalide), le tour
 * repart sur le modèle suivant. UNE EXCEPTION, et elle protège l'utilisateur : si le premier
 * modèle a déjà PRÉPARÉ une écriture avant d'échouer, on ne rejoue pas le tour — le second
 * préparerait la même action une deuxième fois. La proposition déjà faite est rendue telle quelle.
 */
export interface TourAssistant {
  user: CurrentUser;
  message: string;
  historique: { role: "user" | "assistant"; content: string }[];
  instructions: string;
  outils: PowerTool[];
  /** Configurations de fournisseur (production) ou modèles AI SDK (tests : le faux modèle). */
  modeles: ModeleTour[];
  delaiMs: number;
  config?: AssistantRoleConfig | null;
  /** Nombre de propositions d'écriture déjà faites pendant le tour (lu après un échec). */
  propositionsFaites: () => number;
  maxEtapes?: number;
}

export interface ResultatTour {
  texte: string;
  outilsAppeles: string[];
  modele: string | null;
  /** Les modèles abandonnés en route, et pourquoi — pour le journal, pas pour l'écran. */
  echecs: { modele: string; raison: string }[];
}

export type ModeleTour = ModeleConfig | { modelId: string; provider?: string };

const nomDe = (m: ModeleTour) => ("providerId" in m ? `${m.providerId}/${m.modelId}` : `${m.provider ?? "modele"}/${m.modelId}`);

export async function repondreAvecSecours(t: TourAssistant): Promise<ResultatTour> {
  const echecs: ResultatTour["echecs"] = [];
  for (const m of t.modeles) {
    const agent = new Agent({
      id: "assistant",
      name: t.config?.assistantName ?? "Assistant",
      instructions: t.instructions,
      model: m as ConstructorParameters<typeof Agent>[0]["model"],
      tools: outilsPour(t.outils, t.user, t.config),
    });
    try {
      // Chaque tour reçoit un rôle LITTÉRAL : Mastra distingue messages utilisateur et assistant par type.
      const messages = [...t.historique, { role: "user" as const, content: t.message }].map((h) =>
        h.role === "user" ? { role: "user" as const, content: h.content } : { role: "assistant" as const, content: h.content },
      );
      const r = await agent.generate(messages, {
        // MESURÉ sur MiMo : « mes dossiers en cours » a enchaîné 5 appels d'outils et épuisé 5 étapes
        // sans rédiger. 8 laisse la place de lire puis de répondre.
        maxSteps: t.maxEtapes ?? 8,
        abortSignal: AbortSignal.timeout(t.delaiMs),
      });
      // MESURÉ : Mastra ne LÈVE PAS sur un délai dépassé (`finishReason: "aborted"`, texte vide) ni
      // sur une panne survenue après un outil — il rend un résultat. Sans ce contrôle, une panne de
      // MiMo s'afficherait comme une réponse vide au lieu d'un échec dit.
      const fin = (r as { finishReason?: string }).finishReason;
      const erreur = (r as { error?: unknown }).error;
      if (fin === "aborted") throw new Error(`délai dépassé (${t.delaiMs} ms)`);
      if (fin === "error" || erreur) throw new Error(erreur instanceof Error ? erreur.message : String(erreur ?? "erreur du modèle"));
      // Des outils lus mais aucune phrase rédigée : un échec à dire, jamais une bulle vide.
      if (!r.text?.trim() && t.propositionsFaites() === 0) throw new Error("aucune réponse rédigée (étapes épuisées)");
      const outilsAppeles = (r.steps ?? []).flatMap((e) =>
        (e.toolCalls ?? []).map((c) => (c as { payload?: { toolName?: string } }).payload?.toolName ?? ""),
      ).filter(Boolean);
      const texte = r.text?.trim() || "J'ai préparé l'action demandée : vérifiez la carte de confirmation.";
      return { texte, outilsAppeles, modele: nomDe(m), echecs };
    } catch (e) {
      echecs.push({ modele: nomDe(m), raison: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      if (t.propositionsFaites() > 0) {
        return { texte: "J'ai préparé l'action demandée : vérifiez la carte de confirmation.", outilsAppeles: [], modele: nomDe(m), echecs };
      }
    }
  }
  throw new Error(`Aucun modèle n'a répondu : ${echecs.map((e) => `${e.modele} (${e.raison})`).join(" ; ") || "aucun modèle configuré"}`);
}
