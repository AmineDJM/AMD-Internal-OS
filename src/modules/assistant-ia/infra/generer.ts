import { Agent } from "@mastra/core/agent";
import { cleFournisseurVoix, modelesAssistant, optionsFournisseur, pourMastra, urlFournisseur } from "./modele";
import type { RoleModele } from "@/platform/ia/modeles-roles";
import { fournisseurDe, type ModeleTour } from "./repondre";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { modeleTrace } from "./qualite/traces";
import { chargerModelesRoles } from "./qualite/modeles";
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
  origine?: Extract<OrigineAppel, "redaction" | "vision" | "ocr" | "memoire">;
  /** J4 : le rôle du modèle (« rapide » pour un résumé roulant) — « standard » par défaut. */
  role?: RoleModele;
  /**
   * K3 : la réponse lue EN FLUX — pour un texte LONG (le rapport d'une recherche approfondie, un livrable de travail). Une
   * requête non diffusée de plus de ~45 s était coupée en 502 par un mandataire ; diffusée, la connexion vit tant qu'elle écrit.
   */
  flux?: boolean;
  /** Direction (02/11/2026) : la lecture d'un long document a son propre budget, hors du plafond par tour (borné par ses parties). */
  horsTour?: boolean;
}

let modelesDeTest: ModeleTour[] | null = null;

export function remplacerModelesPourTests(m: ModeleTour[] | null): void {
  modelesDeTest = m;
}

/** Un test a-t-il remplacé les modèles ? (Les appels annexes — capture de mémoire — ne consomment pas son scénario.) */
export const modelesFactices = (): boolean => modelesDeTest !== null;

/** Les modèles de l'assistant pour un rôle — ou le faux modèle d'un test (le même, quel que soit le rôle). */
export const modelesEffectifs = (role: RoleModele = "standard"): ModeleTour[] => modelesDeTest ?? modelesAssistant(role);

/** Le même appel, lu en flux : le texte, la raison de fin et l'usage, comme `generate` les rend. */
async function enFlux(agent: Agent, messages: never, options: never): Promise<{ text: string; finishReason?: string; usage?: unknown }> {
  const s = await agent.stream(messages, options);
  let text = "";
  const lecteur = s.textStream.getReader();
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    text += String(value ?? "");
  }
  // P1 (décision 0047) : un flux qui s'arrête SANS texte porte souvent l'erreur du fournisseur (clé refusée, crédit épuisé) —
  // la rendre, sinon l'étape d'une mission échoue sur « aucune réponse » et personne ne sait pourquoi.
  const erreur = (s as { error?: unknown }).error;
  if (!text && erreur) throw erreur instanceof Error ? erreur : new Error(String(erreur));
  return { text: text || (await s.text), finishReason: await s.finishReason, usage: await s.usage };
}

export async function genererTexte(consigne: string, texte: string, delaiMs = 60_000, opts: OptionsGeneration = {}): Promise<{ ok: true; texte: string } | { ok: false; raison: string }> {
  await chargerModelesRoles();
  const modeles = modelesEffectifs(opts.role);
  if (!modeles.length) return { ok: false, raison: "L'assistant n'a pas de modèle configuré." };
  // L'interrupteur général — lu ici comme dans `repondreAvecSecours` : l'autre porte vers le modèle.
  if (await interrupteurIaCoupe()) return { ok: false, raison: REFUS_IA_COUPEE };

  const ouvert = await budgetDeLAppel(opts.origine ?? "redaction", opts.horsTour === true);
  if (!ouvert.ok) return ouvert;
  const { budget, proprietaire } = ouvert;

  const debut = Date.now();
  let resultat: { ok: true; texte: string } | { ok: false; raison: string } = { ok: false, raison: "aucune réponse" };
  try {
    for (const m of modeles) {
      try {
        const agent = new Agent({ id: "redaction", name: "Rédaction", instructions: consigne, model: modeleTrace(pourMastra(m), opts.origine ?? "redaction") as ConstructorParameters<typeof Agent>[0]["model"] });
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
        const options = { maxSteps: 1, abortSignal: AbortSignal.timeout(delaiMs), providerOptions: optionsFournisseur(m) } as never;
        const messages = [{ role: "user" as const, content: contenu }] as never;
        const r = opts.flux ? await enFlux(agent, messages, options) : await agent.generate(messages, options);
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

/**
 * M1 (décision 0045) — LES PLONGEMENTS de la mémoire (text-embedding-3-small, 512 dimensions, comme la Bibliothèque) :
 * la même garde que le texte (interrupteur, budget de la personne, journal K8 sous l'usage « memoire »). `null` sans clé,
 * sous le faux modèle d'un test, ou en panne : le rappel reste lexical.
 */
export const MODELE_PLONGEMENT = (process.env.ASSISTANT_IA_EMBED_MODEL || "text-embedding-3-small").trim();
export async function plongerTextes(textes: readonly string[]): Promise<number[][] | null> {
  if (!textes.length || modelesDeTest || !cleFournisseurVoix()) return null;
  if (await interrupteurIaCoupe()) return null;
  const ouvert = await budgetDeLAppel("memoire");
  if (!ouvert.ok) return null;
  const debut = Date.now();
  let ok = false;
  try {
    const r = await fetch(urlFournisseur("/embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cleFournisseurVoix()}` },
      body: JSON.stringify({ model: MODELE_PLONGEMENT, input: textes.map((t) => t.slice(0, 4_000)), dimensions: 512 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
    ouvert.budget.enregistrer({ provider: "openai", model: MODELE_PLONGEMENT, entree: j.usage?.prompt_tokens ?? 0, sortie: 0, cache: 0, raisonnement: 0, ms: Date.now() - debut });
    if (!Array.isArray(j.data) || j.data.length !== textes.length) return null;
    const out: number[][] = new Array(textes.length);
    for (const d of j.data) out[d.index] = d.embedding;
    ok = true;
    return out;
  } catch {
    return null;
  } finally {
    if (ouvert.proprietaire) await fermerBudget(ouvert.budget, { ok, erreur: ok ? null : "plongement", ms: Date.now() - debut });
  }
}
