import { Agent } from "@mastra/core/agent";
import { modelesAssistant } from "@/lib/agent/modele";
import { fournisseurDe, type ModeleTour } from "@/lib/agent/repondre";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { appelDepuisEtape, fermerBudget, ouvrirBudget, PlafondIaAtteint, porteurCourant, type Budget } from "@/lib/agent/consommation";

/**
 * UN APPEL DE RÉDACTION SANS OUTIL — pour les travaux de documents qui dépassent un tour :
 * résumer un long PDF par morceaux, traduire un document paragraphe par paragraphe.
 *
 * Le texte confié ici a DÉJÀ passé les filtres de l'appelant (pièce d'identité refusée, bulletin de
 * paie refusé, coordonnées bancaires masquées). Ce module ne lit rien lui-même : il rédige.
 * Les tests remplacent le modèle par le faux modèle (`remplacerModelesPourTests`).
 *
 * COMPTÉ ET BORNÉ (lot V3-D) : appelé PAR UN OUTIL pendant un tour, l'appel s'inscrit dans le budget de
 * ce tour (un résumé de 14 parties ne contourne pas le plafond du tour) ; appelé hors tour (une
 * opération confirmée, la comparaison d'une routine), il ouvre son propre budget au nom de la
 * personne portée par l'exécution (`auNomDe`).
 */
let modelesDeTest: ModeleTour[] | null = null;

export function remplacerModelesPourTests(m: ModeleTour[] | null): void {
  modelesDeTest = m;
}

/** Les modèles de l'assistant — ou le faux modèle d'un test. */
export const modelesEffectifs = (): ModeleTour[] => modelesDeTest ?? modelesAssistant();

export async function genererTexte(consigne: string, texte: string, delaiMs = 60_000): Promise<{ ok: true; texte: string } | { ok: false; raison: string }> {
  const modeles = modelesEffectifs();
  if (!modeles.length) return { ok: false, raison: "L'assistant n'a pas de modèle configuré." };
  // L'interrupteur général — lu ici comme dans `repondreAvecSecours` : l'autre porte vers le modèle.
  if (await interrupteurIaCoupe()) return { ok: false, raison: REFUS_IA_COUPEE };

  const porteur = porteurCourant();
  let budget: Budget;
  let proprietaire = false;
  if (porteur?.budget) {
    budget = porteur.budget;
    if (budget.depasse) return { ok: false, raison: budget.refus() };
  } else {
    try {
      budget = await ouvrirBudget({ userId: porteur?.userId ?? null, origine: "redaction", conversation: porteur?.conversation });
      proprietaire = true;
    } catch (e) {
      if (e instanceof PlafondIaAtteint) return { ok: false, raison: e.message };
      throw e;
    }
  }

  const debut = Date.now();
  let resultat: { ok: true; texte: string } | { ok: false; raison: string } = { ok: false, raison: "aucune réponse" };
  try {
    for (const m of modeles) {
      try {
        const agent = new Agent({ id: "redaction", name: "Rédaction", instructions: consigne, model: m as ConstructorParameters<typeof Agent>[0]["model"] });
        const t0 = Date.now();
        const r = await agent.generate([{ role: "user" as const, content: texte }], { maxSteps: 1, abortSignal: AbortSignal.timeout(delaiMs) });
        budget.enregistrer(appelDepuisEtape(fournisseurDe(m), (r as { usage?: unknown }).usage, Date.now() - t0));
        const fin = (r as { finishReason?: string }).finishReason;
        if (fin === "aborted") throw new Error(`délai dépassé (${delaiMs} ms)`);
        if (r.text?.trim()) {
          resultat = { ok: true, texte: r.text.trim() };
          return resultat;
        }
      } catch (e) {
        resultat = { ok: false, raison: e instanceof Error ? e.message : String(e) };
      }
    }
    return resultat;
  } finally {
    if (proprietaire) await fermerBudget(budget, { ok: resultat.ok, erreur: resultat.ok ? null : resultat.raison, ms: Date.now() - debut });
  }
}
