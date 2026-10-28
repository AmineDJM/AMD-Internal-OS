import { Agent } from "@mastra/core/agent";
import type { AssistantRoleConfig } from "@prisma/client";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { outilsPour } from "@/lib/agent/outils";
import type { ModeleConfig } from "@/lib/agent/modele";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { appelDepuisEtape, fermerBudget, ouvrirBudget, PlafondIaAtteint, sousBudget, type Budget, type OrigineAppel } from "@/lib/agent/consommation";

// L'UI générative (R5) se lit au même endroit que le tour : l'action de l'écran n'a qu'une porte
// vers le moteur — un import de plus depuis `app/(app)/assistant/` serait un franchissement de plus.
export { composantsEnBlocs, lireReponseModele } from "@/lib/agent/ui/composants";
export { piecesDuMessage } from "@/lib/agent/operations/pieces";

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
  /** EN FLUX : le texte brut lu jusqu'ici, à chaque morceau — le premier mot s'affiche sans attendre la fin. */
  surTexte?: (brut: string) => void;
  /** EN FLUX : un outil appelé (nom technique), au moment de l'appel. */
  surOutil?: (nom: string) => void;
  /** Pour le journal : d'où part le tour, et la conversation (le fil) à laquelle il appartient. */
  origine?: OrigineAppel;
  conversation?: string | null;
}

/** Ce que reçoivent `generate` et `stream` : la borne d'étapes, l'arrêt (délai OU budget), le compteur. */
interface OptionsBoucle {
  maxSteps: number;
  abortSignal: AbortSignal;
  onStepFinish: (etape: { usage?: unknown; finishReason?: string }) => void;
}

type Resultat = { text?: string; finishReason?: string; error?: unknown; steps?: { toolCalls?: unknown[] }[] };

/**
 * LE TOUR EN FLUX — même agent, même boucle d'outils, mais lu morceau par morceau : le texte et les
 * appels d'outils sont rendus à mesure (`surTexte`, `surOutil`), puis le résultat final est le même
 * que `generate` (texte, étapes, raison de fin, erreur).
 */
async function enFlux(agent: Agent, messages: Parameters<Agent["generate"]>[0], t: TourAssistant, o: OptionsBoucle): Promise<Resultat> {
  const s = await agent.stream(messages, o as never);
  let brut = "";
  const lecteur = s.fullStream.getReader();
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    const c = value as { type?: string; payload?: { text?: string; toolName?: string } };
    if (c.type === "text-delta" && c.payload?.text) {
      brut += c.payload.text;
      t.surTexte?.(brut);
    } else if (c.type === "tool-call" && c.payload?.toolName) {
      t.surOutil?.(c.payload.toolName);
      // Un nouveau pas commence après l'outil : le texte d'avant (« je regarde… ») n'est pas la réponse.
      brut = "";
    }
  }
  return { text: await s.text, finishReason: await s.finishReason, error: s.error, steps: (await s.steps) as Resultat["steps"] };
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

/** Le fournisseur et le modèle, séparés — les deux colonnes du journal. */
export const fournisseurDe = (m: ModeleTour) => ({ provider: "providerId" in m ? m.providerId : m.provider ?? "modele", model: m.modelId });

/**
 * L'INTERRUPTEUR GÉNÉRAL (Administration › Contrôle de l'IA), lu LÀ OÙ LES APPELS PASSENT : les deux
 * seules portes de l'Assistant IA vers MiMo sont `repondreAvecSecours` (conversation, fil, routines)
 * et `genererTexte` (résumés, traductions). Coupé, aucun appel ne part — la conversation, le fil en
 * arrière-plan et les routines le disent avec la phrase du refus, au lieu d'envoyer quand même.
 */
export class IaCoupee extends Error {
  constructor() { super(REFUS_IA_COUPEE); this.name = "IaCoupee"; }
}

/**
 * LE BUDGET DU TOUR (lot V3-D) — ouvert APRÈS l'interrupteur, AVANT le premier appel : plafond du jour
 * atteint, rien ne part (`PlafondIaAtteint`). Chaque étape est comptée ; la borne franchie, la boucle
 * s'arrête (l'appel suivant ne part pas) et le tour le dit. Fermé quoi qu'il arrive : le journal
 * garde aussi les tours qui échouent.
 */
export async function repondreAvecSecours(t: TourAssistant): Promise<ResultatTour> {
  if (await interrupteurIaCoupe()) throw new IaCoupee();
  const budget = await ouvrirBudget({ userId: t.user.id, origine: t.origine ?? "conversation", conversation: t.conversation });
  const debut = Date.now();
  let echec: string | null = null;
  let outils = 0;
  try {
    const r = await sousBudget(budget, () => boucle(t, budget));
    outils = r.outilsAppeles.length;
    return r;
  } catch (e) {
    echec = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await fermerBudget(budget, { ok: echec == null, erreur: echec, ms: Date.now() - debut, outils });
  }
}

const TEXTE_CARTE_PREPAREE = "J'ai préparé l'action demandée : vérifiez la carte de confirmation.";

async function boucle(t: TourAssistant, budget: Budget): Promise<ResultatTour> {
  // La borne d'étapes : celle que demande l'appelant, jamais au-delà du réglage du Super Admin.
  const maxSteps = Math.min(t.maxEtapes ?? 8, budget.reglages.etapesMaxTour);
  const echecs: ResultatTour["echecs"] = [];
  for (const m of t.modeles) {
    const agent = new Agent({
      id: "assistant",
      name: t.config?.assistantName ?? "Assistant",
      instructions: t.instructions,
      model: m as ConstructorParameters<typeof Agent>[0]["model"],
      tools: outilsPour(t.outils, t.user, t.config),
    });
    const arret = new AbortController();
    let debutEtape = Date.now();
    const o: OptionsBoucle = {
      // MESURÉ sur MiMo : « mes dossiers en cours » a enchaîné 5 appels d'outils et épuisé 5 étapes
      // sans rédiger. 8 laisse la place de lire puis de répondre.
      maxSteps,
      abortSignal: AbortSignal.any([arret.signal, AbortSignal.timeout(t.delaiMs)]),
      onStepFinish: (etape) => {
        const appel = appelDepuisEtape(fournisseurDe(m), etape.usage, Date.now() - debutEtape);
        debutEtape = Date.now();
        // Borne franchie ET un appel de plus allait partir (l'étape a demandé des outils) : on arrête.
        // Une étape qui a RÉDIGÉ la réponse finit le tour — on ne jette pas une réponse déjà payée.
        if (budget.enregistrer(appel) && etape.finishReason === "tool-calls") arret.abort(new PlafondIaAtteint(budget.refus()));
      },
    };
    try {
      // Chaque tour reçoit un rôle LITTÉRAL : Mastra distingue messages utilisateur et assistant par type.
      const messages = [...t.historique, { role: "user" as const, content: t.message }].map((h) =>
        h.role === "user" ? { role: "user" as const, content: h.content } : { role: "assistant" as const, content: h.content },
      );
      const r: Resultat = t.surTexte || t.surOutil
        ? await enFlux(agent, messages, t, o)
        : await agent.generate(messages, o as never);
      // MESURÉ : Mastra ne LÈVE PAS sur un délai dépassé (`finishReason: "aborted"`, texte vide) ni
      // sur une panne survenue après un outil — il rend un résultat. Sans ce contrôle, une panne de
      // MiMo s'afficherait comme une réponse vide au lieu d'un échec dit.
      const fin = r.finishReason;
      const erreur = r.error;
      // Arrêté par le BUDGET, pas par le délai : on le dit tel quel, et aucun autre modèle ne reprend.
      if (fin === "aborted" && arret.signal.aborted) throw new PlafondIaAtteint(budget.refus());
      if (fin === "aborted") throw new Error(`délai dépassé (${t.delaiMs} ms)`);
      if (fin === "error" || erreur) throw new Error(erreur instanceof Error ? erreur.message : String(erreur ?? "erreur du modèle"));
      // Des outils lus mais aucune phrase rédigée : un échec à dire, jamais une bulle vide.
      if (!r.text?.trim() && t.propositionsFaites() === 0) throw new Error("aucune réponse rédigée (étapes épuisées)");
      const outilsAppeles = (r.steps ?? []).flatMap((e) =>
        (e.toolCalls ?? []).map((c) => (c as { payload?: { toolName?: string } }).payload?.toolName ?? ""),
      ).filter(Boolean);
      const texte = r.text?.trim() || TEXTE_CARTE_PREPAREE;
      return { texte, outilsAppeles, modele: nomDe(m), echecs };
    } catch (e) {
      // Le plafond n'est pas une panne : rejouer le tour sur un autre modèle dépenserait encore.
      if (e instanceof PlafondIaAtteint) {
        if (t.propositionsFaites() > 0) return { texte: TEXTE_CARTE_PREPAREE, outilsAppeles: [], modele: nomDe(m), echecs };
        throw e;
      }
      echecs.push({ modele: nomDe(m), raison: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      if (t.propositionsFaites() > 0) {
        return { texte: TEXTE_CARTE_PREPAREE, outilsAppeles: [], modele: nomDe(m), echecs };
      }
    }
  }
  throw new Error(`Aucun modèle n'a répondu : ${echecs.map((e) => `${e.modele} (${e.raison})`).join(" ; ") || "aucun modèle configuré"}`);
}
