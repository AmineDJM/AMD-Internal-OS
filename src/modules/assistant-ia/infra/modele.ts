/**
 * LE MODÈLE DE L'ASSISTANT — OpenAI `gpt-6.1-terra`, par la clé OpenAI déjà en service (Direction,
 * 28/10/2026 : « l'API de l'assistant IA doit être celle d'OpenAI qu'on a déjà »). Il remplace MiMo
 * (décision 0006), dont la clé n'avait jamais été posée en production : l'assistant y répondait
 * « IA non configurée ».
 *
 * Pas de modèle de secours : si le modèle échoue ou dépasse le délai, l'assistant le dit plutôt que
 * de répondre avec un autre fournisseur. La clé n'est lue qu'ici, jamais écrite dans le code.
 */
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { cleOpenAI } from "@/lib/models/openai-acces";
import { MODELE_STANDARD_DEFAUT, modelePourRole, type EffortRaisonnement, type RoleModele } from "@/platform/ia/modeles-roles";

/** Le modèle par défaut ; `ASSISTANT_IA_MODEL` le change sans redéploiement de code. */
export const MODELE_ASSISTANT_DEFAUT = MODELE_STANDARD_DEFAUT;

/** Délai d'un tour complet (mesuré : ~6 s par appel, 2 à 3 appels par tour avec outils). */
export const DELAI_MODELE_MS = Number(process.env.ASSISTANT_IA_TIMEOUT_MS) || 45_000;

export interface ModeleConfig {
  providerId: string;
  modelId: string;
  apiKey: string;
  /** J4 : l'effort de raisonnement du rôle (`platform/ia/modeles-roles.ts`). */
  effort?: EffortRaisonnement;
}

/**
 * Le modèle OpenAI de l'assistant pour un RÔLE (J4 : rapide, standard, raisonnement) — `null` tant que
 * `OPENAI_API_KEY` n'est pas posée.
 */
export function modeleOpenAi(env: NodeJS.ProcessEnv = process.env, role: RoleModele = "standard"): ModeleConfig | null {
  const apiKey = cleOpenAI(env);
  if (!apiKey) return null;
  const choix = modelePourRole(role, env);
  return { providerId: "openai", modelId: choix.modelId, apiKey, effort: choix.effort };
}

/**
 * Ce que l'Assistant IA répond quand aucun modèle n'est configuré : le geste EXACT (§118.128), pas
 * « l'IA n'est pas configurée » — phrase vraie qui ne dit ni quelle clé ni où la poser.
 */
export const IA_NON_CONFIGUREE = phraseIaNonConfiguree("OPENAI_API_KEY", "l'Assistant IA");

/** Les modèles à essayer, dans l'ordre. Vide = IA non configurée. */
export function modelesAssistant(role: RoleModele = "standard"): ModeleConfig[] {
  const m = modeleOpenAi(process.env, role);
  return m ? [m] : [];
}

export const estOpenAi = (m: unknown): m is ModeleConfig =>
  typeof m === "object" && m !== null && (m as Partial<ModeleConfig>).providerId === "openai";

/**
 * CE QUE MASTRA REÇOIT. Le routeur `openai/<modèle>` parle l'API **Responses** : mesuré le 28/10/2026,
 * `/v1/chat/completions` refuse les outils avec raisonnement sur `gpt-6.1-terra` (« use /v1/responses
 * or set reasoning_effort to 'none' ») — or chaque tour de l'assistant porte ses outils. Un modèle de
 * banc (sans `providerId`) passe tel quel.
 */
export function pourMastra<T>(m: T): T | { id: `openai/${string}`; apiKey: string } {
  return estOpenAi(m) ? { id: `openai/${m.modelId}`, apiKey: m.apiKey } : m;
}

/**
 * LES OPTIONS DU FOURNISSEUR d'un appel (J4) : l'effort de raisonnement du rôle, et la clé de cache du préfixe — les
 * appels d'une même personne partagent le même début de consigne, le fournisseur les route vers le même cache.
 */
export function optionsFournisseur(m: unknown, cleCache?: string): { openai: Record<string, string> } | undefined {
  if (!estOpenAi(m)) return undefined;
  return { openai: { ...(m.effort ? { reasoningEffort: m.effort } : {}), ...(cleCache ? { promptCacheKey: cleCache } : {}) } };
}
