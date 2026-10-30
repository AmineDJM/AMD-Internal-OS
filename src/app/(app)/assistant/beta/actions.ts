"use server";

import { requireUser, type CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { jouerTour, type MemoireProposee } from "@/modules/assistant-ia/api";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";

export interface ReponseBetaAction {
  ok: boolean;
  messageId: string;
  role: "assistant";
  content: string;
  /** L'UI générative (R5) : les composants choisis par le modèle, PROUVÉS par les outils du tour. */
  blocs?: WorkspaceBlock[];
  /** Une mémoire PROPOSÉE : rien n'est retenu avant le geste « Retenir » de la personne. */
  memoireProposee?: MemoireProposee | null;
  outilsAppeles: string[];
  intent?: {
    id: string;
    kind: string;
    title: string;
    summary?: string;
    /** Ce que la personne doit savoir AVANT de confirmer (doublon, seuil, pièce, budget). */
    warnings?: string[];
    /** CRITIQUE : la valeur à ressaisir pour armer la confirmation (vérifiée par le serveur). */
    confirmText?: string;
    /** Le libellé du bouton quand « Confirmer » ne dit pas le geste. */
    libelleBouton?: string;
    fields?: { label: string; value: string }[];
    status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
    resultLink?: string;
    resultMessage?: string;
  } | null;
  error?: string;
}

/**
 * LE GARDE — le module `ASSISTANT_IA` (`peutUtiliserAssistantIA`) : le Super Admin, et chaque
 * personne à qui il l'a ouvert. Une action serveur s'appelle sans passer par la page : le
 * contrôle vit donc ici aussi.
 */
async function exigerAccesAssistant(): Promise<CurrentUser | null> {
  const user = await requireUser();
  return peutUtiliserAssistantIA(user) ? user : null;
}

const REFUS = REFUS_ASSISTANT_IA;
const MAX_TOURS_HISTORIQUE = 12;

type Tour = { role: "user" | "assistant"; content: string };

/** L'historique vient du navigateur : seulement des tours `user`/`assistant` en texte, bornés. */
function historiqueSur(historique: unknown): Tour[] {
  if (!Array.isArray(historique)) return [];
  return historique
    .filter((t): t is Tour =>
      !!t && typeof t === "object"
      && ((t as Tour).role === "user" || (t as Tour).role === "assistant")
      && typeof (t as Tour).content === "string"
      && (t as Tour).content.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.content }))
    .slice(-MAX_TOURS_HISTORIQUE);
}

/**
 * Valide et exécute une action proposée. Seule l'INTENTION est reçue, jamais un payload : celui
 * qui s'exécute est STOCKÉ sur l'intention de CE compte. `confirmerIntentionAssistantIA` garde
 * l'idempotence, la confirmation forte et revérifie le droit au moment de l'exécution (Q14).
 */
export async function confirmerActionBeta(intentId: string, confirmTyped?: string) {
  const user = await exigerAccesAssistant();
  if (!user) return { ok: false as const, error: REFUS };
  return confirmerIntentionAssistantIA(intentId, confirmTyped);
}

/**
 * Un message à l'assistant, joué DANS la requête et sans rien garder — l'écran ne s'en sert plus qu'en
 * « Vue exacte » (le fil gardé, `agent/fil/service.ts`, joue tout le reste en arrière-plan). La règle
 * du tour est la même des deux côtés : `jouerTour`.
 */
export async function envoyerMessageBeta(
  userPrompt: string,
  _moduleFilter?: string,
  historique: { role: string; content: string }[] = [],
  piecesJointes: { id: string; nom?: string }[] = [],
): Promise<ReponseBetaAction> {
  const messageId = `msg-${Date.now()}`;
  const user = await exigerAccesAssistant();
  if (!user) return { ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error: REFUS };
  const r = await jouerTour(user, { texte: userPrompt, pieces: piecesJointes, historique: historiqueSur(historique) });
  if (!r.ok) return { ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error: r.error };
  return {
    ok: true, messageId, role: "assistant", content: r.content, blocs: r.blocs,
    memoireProposee: r.memoireProposee, outilsAppeles: r.outilsAppeles, intent: r.intent,
  };
}
