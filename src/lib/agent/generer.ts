import { Agent } from "@mastra/core/agent";
import { modelesAssistant } from "@/lib/agent/modele";
import type { ModeleTour } from "@/lib/agent/repondre";

/**
 * UN APPEL DE RÉDACTION SANS OUTIL — pour les travaux de documents qui dépassent un tour :
 * résumer un long PDF par morceaux, traduire un document paragraphe par paragraphe.
 *
 * Le texte confié ici a DÉJÀ passé les filtres de l'appelant (pièce d'identité refusée, bulletin de
 * paie refusé, coordonnées bancaires masquées). Ce module ne lit rien lui-même : il rédige.
 * Les tests remplacent le modèle par le faux modèle (`remplacerModelesPourTests`).
 */
let modelesDeTest: ModeleTour[] | null = null;

export function remplacerModelesPourTests(m: ModeleTour[] | null): void {
  modelesDeTest = m;
}

export async function genererTexte(consigne: string, texte: string, delaiMs = 60_000): Promise<{ ok: true; texte: string } | { ok: false; raison: string }> {
  const modeles: ModeleTour[] = modelesDeTest ?? modelesAssistant();
  if (!modeles.length) return { ok: false, raison: "L'assistant n'a pas de modèle configuré." };
  let raison = "aucune réponse";
  for (const m of modeles) {
    try {
      const agent = new Agent({ id: "redaction", name: "Rédaction", instructions: consigne, model: m as ConstructorParameters<typeof Agent>[0]["model"] });
      const r = await agent.generate([{ role: "user" as const, content: texte }], { maxSteps: 1, abortSignal: AbortSignal.timeout(delaiMs) });
      const fin = (r as { finishReason?: string }).finishReason;
      if (fin === "aborted") throw new Error(`délai dépassé (${delaiMs} ms)`);
      if (r.text?.trim()) return { ok: true, texte: r.text.trim() };
    } catch (e) {
      raison = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, raison };
}
