import { Agent } from "@mastra/core/agent";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { outilsPour } from "@/lib/agent/outils";

/**
 * L'AGENT — le cerveau neuf (Q1), à côté de l'ancien assistant.
 *
 * Ce module ne connaît ni Prisma ni les écrans : il reçoit un modèle, des outils et un
 * utilisateur. Les outils sont filtrés par le droit de CET utilisateur avant même d'être montrés
 * au modèle (`outilsPour`) ; un agent est construit PAR REQUÊTE, il ne retient donc rien d'un
 * utilisateur à l'autre. Le contexte compilé et la configuration du rôle (jalons 3 et 4)
 * arriveront par `instructions`.
 */
// Le type du modèle est celui qu'attend Mastra : un fournisseur AI SDK, ou le faux modèle des tests.
type ModeleAgent = ConstructorParameters<typeof Agent>[0]["model"];

export interface OptionsAgent {
  user: CurrentUser;
  modele: ModeleAgent;
  outils: PowerTool[];
  instructions?: string;
}

const INSTRUCTIONS_DE_BASE =
  "Tu es l'assistant interne d'Adventum Pharma. Tu réponds en français, en texte simple. " +
  "Tu n'inventes jamais une personne, un produit, une adresse ni un chiffre : si un outil ne les donne pas, tu le dis.";

export function creerAgent({ user, modele, outils, instructions }: OptionsAgent) {
  return new Agent({
    id: "assistant",
    name: "Assistant",
    instructions: instructions ?? INSTRUCTIONS_DE_BASE,
    model: modele,
    tools: outilsPour(outils, user),
  });
}

export interface ReponseAgent {
  texte: string;
  /** Les outils réellement appelés, dans l'ordre — la trace « ce que l'assistant a consulté ». */
  outilsAppeles: string[];
}

/** Un tour de conversation, borné : l'agent ne tourne pas indéfiniment sur ses propres appels. */
export async function repondre(agent: ReturnType<typeof creerAgent>, message: string, maxEtapes = 5): Promise<ReponseAgent> {
  const resultat = await agent.generate(message, { maxSteps: maxEtapes });
  const appels = (resultat.steps ?? []).flatMap((e) => (e.toolCalls ?? []).map((c) => (c as { payload?: { toolName?: string }; toolName?: string }).payload?.toolName ?? (c as { toolName?: string }).toolName ?? ""));
  return { texte: resultat.text, outilsAppeles: appels.filter(Boolean) };
}
