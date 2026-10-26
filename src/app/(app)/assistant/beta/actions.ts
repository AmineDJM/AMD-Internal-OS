"use server";

import { requireUser, type CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/platform/in-process/visibilite-adam";
import { confirmerIntentionAssistantIA } from "@/lib/actions/assistant-actions";
import { compileContext } from "@/lib/agent/contexte";
import { getRoleConfig, resoudreConsignesRole } from "@/lib/agent/role-config";
import { outilsV1, type PropositionPreparee } from "@/lib/agent/outils-v1";
import { DELAI_MIMO_MS, modelesAssistant } from "@/lib/agent/modele";
import { repondreAvecSecours } from "@/lib/agent/repondre";

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
export async function confirmerActionBeta(intentId: string) {
  const user = await exigerAccesAssistant();
  if (!user) return { ok: false as const, error: REFUS };
  return confirmerIntentionAssistantIA(intentId);
}

/** Un message à l'assistant : moteur Mastra, MiMo d'abord, secours du registre (R4). */
export async function envoyerMessageBeta(
  userPrompt: string,
  _moduleFilter?: string,
  historique: { role: string; content: string }[] = [],
): Promise<ReponseBetaAction> {
  const messageId = `msg-${Date.now()}`;
  const echec = (error: string): ReponseBetaAction => ({ ok: false, messageId, role: "assistant", content: "", outilsAppeles: [], error });

  const user = await exigerAccesAssistant();
  if (!user) return echec(REFUS);
  const message = (userPrompt ?? "").trim();
  if (!message) return echec("Message vide.");

  const modeles = modelesAssistant();
  if (modeles.length === 0) return echec("L'IA n'est pas configurée sur ce serveur.");

  let instructions: string;
  let config;
  try {
    config = await getRoleConfig(user.role);
    instructions = (await compileContext({ user, consignesRole: resoudreConsignesRole(config) })).systemPrompt;
  } catch (e) {
    // ÉCHEC FERMÉ (Q17) : sans contexte, l'agent ne sait pas qui lui parle — il ne répond pas.
    console.error("[assistant] contexte indisponible", e);
    return echec("Service momentanément indisponible. Réessayez dans un instant.");
  }

  const propositions: PropositionPreparee[] = [];
  try {
    const r = await repondreAvecSecours({
      user, message, historique: historiqueSur(historique), instructions,
      outils: outilsV1(user, propositions), modeles, delaiMs: DELAI_MIMO_MS, config,
      propositionsFaites: () => propositions.length,
    });
    if (r.echecs.length) console.warn("[assistant] modèles abandonnés", r.echecs);
    const p = propositions[0];
    return {
      ok: true,
      messageId,
      role: "assistant",
      content: r.texte,
      outilsAppeles: r.outilsAppeles,
      intent: p ? { id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields, status: "PROPOSED" } : null,
    };
  } catch (e) {
    console.error("[assistant] aucun modèle n'a répondu", e);
    return echec("L'assistant n'a pas pu répondre. Réessayez dans un instant.");
  }
}
