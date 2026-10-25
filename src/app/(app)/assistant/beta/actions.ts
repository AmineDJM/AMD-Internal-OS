"use server";

import { requireUser, type CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { peutVoirAdam } from "@/platform/in-process/visibilite-adam";
import { runAssistant, type AssistantActionPayload, type ChatTurn } from "@/lib/assistant";
import { executeAssistantAction } from "@/lib/actions/assistant-actions";

export interface ReponseBetaAction {
  ok: boolean;
  messageId: string;
  role: "assistant";
  content: string;
  outilsAppeles: string[];
  intent?: {
    id: string;
    kind: string;
    title: string;
    summary?: string;
    fields?: { label: string; value: string }[];
    status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
    resultLink?: string;
    resultMessage?: string;
  } | null;
  error?: string;
}

/**
 * LE GARDE — celui de l'assistant de production (`peutVoirAdam`).
 *
 * Une action serveur s'appelle sans passer par la page qui l'affiche : le contrôle vit donc ici
 * aussi, pas seulement dans la page.
 */
async function exigerAccesAssistant(): Promise<CurrentUser | null> {
  const user = await requireUser();
  return peutVoirAdam(user) ? user : null;
}

const REFUS = "L'assistant ne vous est pas ouvert.";
const MAX_TOURS_HISTORIQUE = 12;

/**
 * L'historique vient du navigateur : on n'en garde que des tours `user`/`assistant` en texte,
 * bornés. Un rôle `system` glissé par le client n'atteint jamais le moteur.
 */
function historiqueSur(historique: unknown): ChatTurn[] {
  if (!Array.isArray(historique)) return [];
  return historique
    .filter((t): t is ChatTurn =>
      !!t && typeof t === "object"
      && ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant")
      && typeof (t as ChatTurn).content === "string"
      && (t as ChatTurn).content.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.content }))
    .slice(-MAX_TOURS_HISTORIQUE);
}

/**
 * Valide et exécute une action proposée, sous confirmation humaine.
 *
 * Le payload exécuté est celui STOCKÉ sur l'intention à la proposition — jamais un payload venu
 * du client. `executeAssistantAction` garde l'idempotence, la confirmation forte des actions
 * CRITIQUES et revérifie l'accès.
 */
export async function confirmerActionBeta(intentId: string) {
  const user = await exigerAccesAssistant();
  if (!user) return { ok: false as const, error: REFUS };
  const intent = await prisma.assistantActionIntent.findFirst({
    where: { id: intentId, userId: user.id },
    select: { payload: true },
  });
  if (!intent) return { ok: false as const, error: "Action introuvable." };
  return executeAssistantAction(intent.payload as unknown as AssistantActionPayload, intentId);
}

/**
 * Un message à l'assistant — même moteur que l'assistant de production (`runAssistant` : boucle
 * d'agent, outils sous RBAC, écritures proposées puis confirmées). Le moteur Mastra le remplacera
 * derrière cette même signature (étape R4).
 */
export async function envoyerMessageBeta(
  userPrompt: string,
  _moduleFilter?: string,
  historique: { role: string; content: string }[] = [],
): Promise<ReponseBetaAction> {
  const messageId = `msg-${Date.now()}`;
  const user = await exigerAccesAssistant();
  if (!user) return { ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error: REFUS };
  const prompt = (userPrompt ?? "").trim();
  if (!prompt) return { ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error: "Message vide." };

  const res = await runAssistant(user, [...historiqueSur(historique), { role: "user", content: prompt }], { origin: "text" });
  if (!res.configured) {
    return { ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error: "L'IA n'est pas configurée sur ce serveur." };
  }
  if (!res.ok) {
    return { ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error: res.reply || "L'assistant n'a pas pu répondre." };
  }

  const proposition = res.proposals?.[0] ?? res.proposal;
  return {
    ok: true,
    messageId,
    role: "assistant",
    content: res.reply,
    outilsAppeles: res.trace ?? [],
    intent: proposition?.intentId
      ? { id: proposition.intentId, kind: proposition.kind, title: proposition.title, fields: proposition.fields, status: "PROPOSED" }
      : null,
  };
}
