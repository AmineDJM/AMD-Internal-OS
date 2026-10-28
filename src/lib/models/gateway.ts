import {
  type ModelBlock,
  type ModelCallOptions,
  type ModelReply,
  type ModelRole,
  type ModelTurn,
  textOf,
} from "./contract";
import { bindingFor } from "./registry";
import { callOpenAi, streamOpenAi } from "./openai";
import { callOpenAiResponses, streamOpenAiResponses } from "./openai-responses";
import { protocolFor, protocolViolation } from "./protocol";
import { validateModelRequest, describeRequest, type ModelRequestShape } from "./capabilities";
import { outputBudget } from "./budget";
import { DEFAULT_VERBOSITY } from "./registry";
import { callAnthropic, streamAnthropic } from "./anthropic";
import { recordModelCall } from "./telemetry";
import { emptyUsage } from "./contract";
import { prendrePlace, estimerJetons, noterConsommation } from "./throttle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PASSERELLE — le SEUL endroit d'Adam qui parle à un fournisseur de modèle.
 *
 * Trois choses, et rien d'autre :
 *   1. résoudre le RÔLE en liaison concrète (quel modèle, chez qui, avec quel effort) ;
 *   2. router vers l'adaptateur correspondant ;
 *   3. consigner l'usage — automatiquement, pour qu'aucun appel ne puisse échapper au compteur.
 *
 * Le point 3 est la raison pour laquelle la passerelle existe plutôt que d'appeler les
 * adaptateurs directement : une mesure qu'on peut oublier de faire finit par ne mesurer qu'une
 * partie, et un chiffre partiel présenté comme un total est pire que pas de chiffre.
 *
 * ── CE QUE CETTE COUCHE NE FAIT PAS ──────────────────────────────────────────────────────
 *
 * Elle ne décide pas QUOI faire, ne boucle pas sur les outils, n'exécute aucune action métier.
 * Elle transporte. La boucle d'agent est au-dessus ; l'exécution réelle est ailleurs encore, et
 * c'est du code — pas un modèle.
 *
 * ── LE QUATRIÈME TRAVAIL, AJOUTÉ APRÈS UN HTTP 400 EN PRODUCTION ─────────────────────────
 *
 * 4. choisir le PROTOCOLE — par quelle porte OpenAI on parle.
 *
 * Il est ici pour la même raison que le point 3 : c'est le seul passage obligé. Tant que
 * l'adaptateur était unique, la question ne se posait pas et ne se testait donc pas. Terra qui
 * raisonne et qui outille n'existe pas sur `/v1/chat/completions` ; l'apprendre par un 400 chez
 * l'utilisateur est le symptôme d'une décision que personne ne prenait.
 *
 * La règle vit dans `protocol.ts`, isolée et vérifiable sans réseau. La passerelle l'applique et
 * REFUSE un appel qui la violerait, plutôt que de l'envoyer voir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * L'appel refusé AVANT le réseau. Rendu sous forme de `ModelReply` et non levé : la boucle
 * d'agent sait déjà lire un `ok: false`, elle ne sait pas rattraper une exception sans perdre
 * l'usage déjà consommé.
 */
function refus(binding: ReturnType<typeof bindingFor>, motif: string): ModelReply {
  console.error(`[models] appel refusé — ${motif}`);
  return {
    ok: false,
    configured: true,
    stop: "error",
    blocks: [],
    usage: emptyUsage(binding.role, binding.model, binding.provider),
    error: `Protocole incompatible : ${motif}`,
  };
}

/**
 * TOUT CE QU'ON DÉCIDE AVANT DE TOUCHER AU RÉSEAU — porte, réglages du rôle, contrôle local.
 *
 * ── POURQUOI CETTE FONCTION EXISTE ───────────────────────────────────────────────────────
 *
 * Deux HTTP 400 sont partis de cette couche : `reasoning_effort` sur la mauvaise porte, puis
 * `temperature` sur un modèle qui le refuse. Dans les deux cas, la question « ce modèle-là
 * accepte-t-il cela ? » n'était posée nulle part avant l'envoi — elle était posée par OpenAI,
 * après, sous forme d'erreur. Elle se pose désormais ICI, et une seule fois.
 *
 * Elle ne CORRIGE rien : elle refuse. Corriger en silence est exactement ce qu'on vient de
 * retirer du produit. En marche normale elle ne trouve d'ailleurs jamais rien, puisque le
 * constructeur ne fabrique pas de champ interdit — elle est là pour le jour où quelqu'un
 * contournera le constructeur.
 */
function preparerOpenAi(
  binding: ReturnType<typeof bindingFor>,
  opts: ModelCallOptions,
  stream = false,
): { protocol: "responses" | "chat_completions"; opts: ModelCallOptions } | { error: string } {
  const protocol = protocolFor(binding, opts);
  const violation = protocolViolation(binding, opts, protocol);
  if (violation) return { error: violation };

  // LES RÉGLAGES DU RÔLE, appliqués ici plutôt que dans l'adaptateur : c'est la passerelle qui
  // connaît les rôles. La concision remplace la température — et elle est réglée par rôle, pas
  // devinée appel par appel.
  //
  // LE BUDGET DE SORTIE SE CALCULE ICI, ET POUR LA MÊME RAISON. `maxOutputTokens` demandé par un
  // appelant est un budget de RÉPONSE VISIBLE (voir `contract.ts`) ; ce qui part sur le réseau
  // couvre aussi la réflexion. Aucun des ~40 appelants du produit n'a à connaître cette
  // différence — et le fait qu'ils l'ignoraient tous est précisément ce qui faisait tourner la
  // boucle d'agent avec 1 400 jetons TOTAUX sur un modèle qui raisonne.
  const effort = opts.reasoning ?? binding.reasoning;
  const budget = outputBudget({
    role: binding.role,
    effort,
    toolCount: opts.tools?.length ?? 0,
    requested: opts.maxOutputTokens ?? null,
    // La recherche web du fournisseur coûte de la SORTIE (délibération entre recherches +
    // items `web_search_call`) — mesuré au Run 4, où un plafond sans ce supplément a coupé
    // une veille en plein vol. Voir SUPPLEMENT_RECHERCHE_WEB dans budget.ts.
    webSearch: Boolean(opts.webSearch),
  });

  const enrichi: ModelCallOptions = {
    ...opts,
    verbosity: opts.verbosity ?? DEFAULT_VERBOSITY[binding.role],
    maxOutputTokens: budget.maxOutputTokens,
  };

  const model = enrichi.modelOverride || binding.model;
  const forme: ModelRequestShape = {
    model,
    protocol,
    reasoning: effort,
    toolCount: enrichi.tools?.length ?? 0,
    webSearch: enrichi.webSearch,
    params: {
      reasoning: { effort },
      textVerbosity: enrichi.verbosity,
      textFormat: enrichi.jsonSchema,
      maxOutputTokens: enrichi.maxOutputTokens ?? null,
      tools: enrichi.tools?.length ? enrichi.tools : undefined,
      toolChoice: enrichi.tools?.length ? (enrichi.toolChoice ?? "auto") : undefined,
      parallelToolCalls: enrichi.tools?.length ? true : undefined,
      store: Boolean(enrichi.previousResponseId),
      previousResponseId: enrichi.previousResponseId,
      include: enrichi.include?.length ? enrichi.include : undefined,
      stream: stream || undefined,
      promptCacheKey: enrichi.promptCacheKey,
      safetyIdentifier: enrichi.safetyIdentifier,
      // `temperature` n'est PAS listé ici, et c'est le point : le contrat ne le porte plus, la
      // passerelle ne le transmet plus, le constructeur ne le fabrique plus.
    },
  };

  const problemes = validateModelRequest(forme);
  if (problemes.length > 0) return { error: problemes[0].message };

  if (process.env.ADAM_MODEL_DEBUG === "1") {
    // Journal EXPURGÉ : la forme de l'appel, jamais son contenu. Voir `describeRequest`.
    // La VENTILATION du budget en fait partie : un `max_output_tokens: 7400` seul ne dit pas si
    // 1 400 sont pour la réponse et 6 000 pour la réflexion, ou l'inverse — et c'est la seule
    // chose qu'on veut savoir en lisant ce journal.
    console.info("[models] requête", JSON.stringify({
      ...describeRequest(forme),
      budget: {
        workload: budget.workload,
        visible: budget.visible,
        reasoningHeadroom: budget.headroom,
        maxOutputTokens: budget.maxOutputTokens,
        requested: opts.maxOutputTokens ?? null,
      },
    }));
  }

  return { protocol, opts: enrichi };
}

/**
 * L'ESTIMATION DE JETONS D'UN APPEL, pour la RÉSERVATION (§61) — l'entrée au caractère près
 * (c'est ce qu'on va sérialiser de toute façon), la sortie au plafond envoyé.
 */
/** Ce qu'une IMAGE pèse dans l'estimation (§38) : ~1 000 jetons de vision — jamais sa longueur en base64, qui ferait refuser la place. */
const CHARS_PAR_IMAGE = 4_000;

function estimationDe(turns: ModelTurn[], opts: ModelCallOptions): number {
  let chars = opts.system?.length ?? 0;
  for (const t of turns) {
    if (typeof t.content === "string") { chars += t.content.length; continue; }
    for (const b of t.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_result") chars += b.content.length;
      else if (b.type === "tool_call") chars += JSON.stringify(b.args ?? {}).length + b.name.length;
      else chars += CHARS_PAR_IMAGE;
    }
  }
  return estimerJetons(chars, opts.maxOutputTokens ?? null);
}

export async function callModel(
  role: ModelRole,
  turns: ModelTurn[],
  opts: ModelCallOptions = {},
): Promise<ModelReply> {
  const binding = bindingFor(role);

  if (binding.provider === "anthropic") {
    const rendre = await prendrePlace(estimationDe(turns, opts));
    try {
      const reply = await callAnthropic(binding, turns, opts);
      recordModelCall(reply.usage);
      return reply;
    } finally {
      rendre();
    }
  }

  const prepare = preparerOpenAi(binding, opts);
  if ("error" in prepare) return refus(binding, prepare.error);

  // LA PORTE (§60) : la place se prend APRÈS la validation locale — un appel refusé avant le
  // réseau ne doit pas consommer de place — et se rend dans un `finally`, quoi qu'il arrive.
  const estimation = estimationDe(turns, prepare.opts);
  const rendre = await prendrePlace(estimation);
  try {
    const reply =
      prepare.protocol === "responses"
        ? await callOpenAiResponses(binding, turns, prepare.opts)
        : await callOpenAi(binding, turns, prepare.opts);
    // La RÉALITÉ face à l'estimation (§61) : ce que le fournisseur a facturé — jetons, cache,
    // recherches web, coût — poussé à la porte pour que l'écart et la facture du run soient des
    // CHIFFRES de rapport, pas des opinions.
    noterConsommation(estimation, reply.usage);
    recordModelCall(reply.usage);
    return reply;
  } finally {
    rendre();
  }
}

export async function streamModel(
  role: ModelRole,
  turns: ModelTurn[],
  opts: ModelCallOptions,
  onText: (chunk: string) => void,
): Promise<ModelReply> {
  const binding = bindingFor(role);

  if (binding.provider === "anthropic") {
    const rendre = await prendrePlace(estimationDe(turns, opts));
    try {
      const reply = await streamAnthropic(binding, turns, opts, onText);
      recordModelCall(reply.usage);
      return reply;
    } finally {
      rendre();
    }
  }

  const prepare = preparerOpenAi(binding, opts, true);
  if ("error" in prepare) return refus(binding, prepare.error);

  const estimation = estimationDe(turns, prepare.opts);
  const rendre = await prendrePlace(estimation);
  try {
    const reply =
      prepare.protocol === "responses"
        ? await streamOpenAiResponses(binding, turns, prepare.opts, onText)
        : await streamOpenAi(binding, turns, prepare.opts, onText);
    noterConsommation(estimation, reply.usage);
    recordModelCall(reply.usage);
    return reply;
  } finally {
    rendre();
  }
}

/**
 * UNE QUESTION, UNE RÉPONSE EN TEXTE. La forme la plus courante — extraction, classification,
 * petit résumé — et celle qu'on veut voir partir sur `worker` ou `bulk`, pas sur l'orchestrateur.
 *
 * Rend `null` en cas d'échec plutôt qu'une chaîne vide : une chaîne vide est une réponse valide
 * pour certaines extractions, et les confondre fait passer une panne pour un résultat.
 */
export async function askModel(
  role: ModelRole,
  prompt: string,
  opts: Omit<ModelCallOptions, "tools"> = {},
): Promise<{ text: string | null; reply: ModelReply }> {
  const reply = await callModel(role, [{ role: "user", content: prompt }], opts);
  return { text: reply.ok ? textOf(reply.blocks) : null, reply };
}

/**
 * UNE RÉPONSE JSON CONFORME À UN SCHÉMA. Le schéma est imposé au fournisseur, donc la conformité
 * est garantie par l'API — pas par la bonne volonté du modèle, ni par un `JSON.parse` optimiste
 * suivi d'un `catch` qui avale l'erreur.
 */
export async function askModelJson<T>(
  role: ModelRole,
  prompt: string,
  schema: { name: string; schema: Record<string, unknown> },
  opts: Omit<ModelCallOptions, "tools" | "jsonSchema"> = {},
): Promise<{ data: T | null; reply: ModelReply }> {
  const reply = await callModel(role, [{ role: "user", content: prompt }], { ...opts, jsonSchema: schema });
  if (!reply.ok) return { data: null, reply };
  const raw = textOf(reply.blocks);
  if (!raw) return { data: null, reply };
  try {
    return { data: JSON.parse(raw) as T, reply };
  } catch {
    return { data: null, reply };
  }
}

/**
 * UNE RÉPONSE JSON À PARTIR D'IMAGES (§38) — le palier SUPÉRIEUR de la lecture visuelle : une
 * page rastérisée illisible en dessous, une capture, un tableau photographié. Mêmes portes que le
 * texte (rôle, protocole, place, télémétrie, coût) ; les images voyagent en blocs du tour
 * utilisateur. Le nombre d'images est BORNÉ ici : le plafond du §38 n'est pas une consigne.
 */
export const IMAGES_MAX_PAR_APPEL = 8;
export async function askModelJsonAvecImages<T>(
  role: ModelRole,
  prompt: string,
  images: readonly { mime: string; data: string; detail?: "low" | "high" }[],
  schema: { name: string; schema: Record<string, unknown> },
  opts: Omit<ModelCallOptions, "tools" | "jsonSchema"> = {},
): Promise<{ data: T | null; reply: ModelReply }> {
  const blocs: ModelBlock[] = [
    { type: "text", text: prompt },
    ...images.slice(0, IMAGES_MAX_PAR_APPEL).map((i): ModelBlock => ({ type: "image", mime: i.mime, data: i.data, ...(i.detail ? { detail: i.detail } : {}) })),
  ];
  const reply = await callModel(role, [{ role: "user", content: blocs }], { ...opts, jsonSchema: schema });
  if (!reply.ok) return { data: null, reply };
  const raw = textOf(reply.blocks);
  if (!raw) return { data: null, reply };
  try {
    return { data: JSON.parse(raw) as T, reply };
  } catch {
    return { data: null, reply };
  }
}

export type {
  ModelCallOptions,
  ModelReply,
  ModelRole,
  ModelTurn,
} from "./contract";
