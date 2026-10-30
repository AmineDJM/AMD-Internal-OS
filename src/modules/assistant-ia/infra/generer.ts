import { Agent } from "@mastra/core/agent";
import { modelesAssistant, pourMastra } from "./modele";
import { fournisseurDe, type ModeleTour } from "./repondre";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { appelDepuisEtape, budgetDeLAppel, fermerBudget, type OrigineAppel } from "./consommation";

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
 *
 * LA VISION passe par ici aussi (décision 0011) : `images` joint des images au texte (photo de facture,
 * page scannée, image clé d'une vidéo) — le même modèle, la même garde, le même budget, le journal sous
 * le rôle « vision ». Une troisième porte vers le modèle aurait été une troisième chose à garder.
 */
export interface ImageJointe {
  octets: Buffer;
  mime: string;
  /** « page 3 sur 9 », « image clé à 0:42 » — dit au modèle pour qu'il situe ce qu'il lit. */
  legende?: string;
}

export interface OptionsGeneration {
  images?: ImageJointe[];
  /** La colonne `role` du journal quand l'appel ouvre son propre budget (« redaction » par défaut). */
  origine?: Extract<OrigineAppel, "redaction" | "vision">;
}

let modelesDeTest: ModeleTour[] | null = null;

export function remplacerModelesPourTests(m: ModeleTour[] | null): void {
  modelesDeTest = m;
}

/** Les modèles de l'assistant — ou le faux modèle d'un test. */
export const modelesEffectifs = (): ModeleTour[] => modelesDeTest ?? modelesAssistant();

export async function genererTexte(consigne: string, texte: string, delaiMs = 60_000, opts: OptionsGeneration = {}): Promise<{ ok: true; texte: string } | { ok: false; raison: string }> {
  const modeles = modelesEffectifs();
  if (!modeles.length) return { ok: false, raison: "L'assistant n'a pas de modèle configuré." };
  // L'interrupteur général — lu ici comme dans `repondreAvecSecours` : l'autre porte vers le modèle.
  if (await interrupteurIaCoupe()) return { ok: false, raison: REFUS_IA_COUPEE };

  const ouvert = await budgetDeLAppel(opts.origine ?? "redaction");
  if (!ouvert.ok) return ouvert;
  const { budget, proprietaire } = ouvert;

  const debut = Date.now();
  let resultat: { ok: true; texte: string } | { ok: false; raison: string } = { ok: false, raison: "aucune réponse" };
  try {
    for (const m of modeles) {
      try {
        const agent = new Agent({ id: "redaction", name: "Rédaction", instructions: consigne, model: pourMastra(m) as ConstructorParameters<typeof Agent>[0]["model"] });
        const t0 = Date.now();
        const contenu = opts.images?.length
          ? [
            { type: "text" as const, text: texte },
            ...opts.images.flatMap((im, i) => [
              { type: "text" as const, text: im.legende ? `Image ${i + 1} — ${im.legende} :` : `Image ${i + 1} :` },
              { type: "image" as const, image: `data:${im.mime};base64,${im.octets.toString("base64")}`, mimeType: im.mime },
            ]),
          ]
          : texte;
        const r = await agent.generate([{ role: "user" as const, content: contenu }] as never, { maxSteps: 1, abortSignal: AbortSignal.timeout(delaiMs) });
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
