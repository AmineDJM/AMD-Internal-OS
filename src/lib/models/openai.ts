import { sanitizeForModel } from "@/lib/ai-text";
import { mentionsUnsupportedTemperature, providerErrorMessage, isRetryableStatus } from "./errors";
import { noterEnTetes, noter429, noterSucces } from "./throttle";
import {
  type ModelBinding,
  type ModelBlock,
  type ModelCallOptions,
  type ModelReply,
  type ModelStop,
  type ModelTurn,
  costOf,
  emptyUsage,
  reponseEnEchec,
  reponseSansCle,
} from "./contract";
import { attendu } from "@/lib/journal";
import { cleOpenAI, urlOpenAI } from "./openai-acces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR OPENAI — il traduit, il ne décide pas.
 *
 * Tout ce qui est propre au fournisseur vit ici et NULLE PART ailleurs : `max_completion_tokens`
 * plutôt que `max_tokens`, les résultats d'outils dans des messages `role: "tool"` plutôt que
 * dans des blocs, et surtout le fait que les arguments d'un appel d'outil arrivent en CHAÎNE
 * JSON alors que la boucle d'agent veut un objet. Cette dernière différence est exactement le
 * genre de détail qui, laissé remonter, se retrouve recopié dans quinze `JSON.parse` défensifs.
 *
 * DEUX LEÇONS VIENNENT DE `openai-luna.ts` — payées en production, et remontées dans `./errors`
 * parce qu'elles décrivent le FOURNISSEUR, pas le module qui les a découvertes :
 *
 *   • `mentionsUnsupportedTemperature` (désormais dans `./errors`) — les modèles de raisonnement
 *     refusent `temperature`. On retire le paramètre et on rejoue, au lieu de rendre une panne.
 *   • le piège de la RÉPONSE VIDE — `max_completion_tokens` couvre AUSSI la réflexion interne.
 *     Un budget calibré pour la seule réponse est englouti par le raisonnement et le contenu
 *     revient vide avec `finish_reason=length`, ce qui devenait « JSON invalide » plus loin,
 *     sans que rien ne nomme la cause.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface OaToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

type OaPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
interface OaMessage {
  role: string;
  content?: string | OaPart[] | null;
  tool_calls?: OaToolCall[];
  tool_call_id?: string;
}

interface OaResponse {
  choices?: { message?: OaMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * ARGUMENTS D'UN APPEL D'OUTIL. Le fournisseur rend une chaîne ; un modèle peut la rendre vide,
 * tronquée ou non-objet. On rend alors un objet VIDE plutôt que de laisser remonter `null` :
 * un outil sans argument est un cas légitime, un `null` est un plantage trois couches plus loin.
 */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  const s = (raw ?? "").trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `finish_reason` du fournisseur → la raison d'arrêt NEUTRE. */
export function stopOf(finish: string | undefined, hasCalls: boolean): ModelStop {
  if (hasCalls) return "tools"; // fait foi : certains modèles rendent "stop" avec des appels
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tools";
    case "length":
      return "length";
    case "content_filter":
      return "refusal";
    case "stop":
      return "end";
    default:
      return finish ? "end" : "error";
  }
}

/**
 * LES TOURS NEUTRES → LES MESSAGES DU FOURNISSEUR.
 *
 * Le point délicat : un tour `user` qui ne porte QUE des `tool_result` ne devient pas un message
 * utilisateur, il devient N messages `role: "tool"`. Mélanger les deux (des résultats d'outils
 * présentés comme une phrase de l'utilisateur) casse le chaînage `tool_call_id` et le modèle
 * réappelle l'outil qu'il vient d'appeler — une boucle qu'on paie deux fois.
 */
export function toOpenAiMessages(turns: ModelTurn[], system?: string): OaMessage[] {
  const out: OaMessage[] = [];
  if (system) out.push({ role: "system", content: sanitizeForModel(system) });

  for (const turn of turns) {
    if (typeof turn.content === "string") {
      out.push({ role: turn.role, content: sanitizeForModel(turn.content) });
      continue;
    }

    const results = turn.content.filter(
      (b): b is Extract<ModelBlock, { type: "tool_result" }> => b.type === "tool_result",
    );
    const texts = turn.content.filter(
      (b): b is Extract<ModelBlock, { type: "text" }> => b.type === "text",
    );
    const calls = turn.content.filter(
      (b): b is Extract<ModelBlock, { type: "tool_call" }> => b.type === "tool_call",
    );

    if (turn.role === "assistant") {
      const text = texts.map((t) => t.text).join("");
      // `content: null` est la forme attendue quand l'assistant n'a fait qu'appeler des outils.
      out.push({
        role: "assistant",
        content: text ? sanitizeForModel(text) : null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    // Côté utilisateur : d'abord les résultats d'outils, chacun dans SON message.
    for (const r of results) {
      out.push({
        role: "tool",
        tool_call_id: r.callId,
        content: sanitizeForModel(r.isError ? `ERREUR : ${r.content}` : r.content),
      });
    }
    const text = texts.map((t) => t.text).join("");
    const images = turn.content.filter((b): b is Extract<ModelBlock, { type: "image" }> => b.type === "image");
    if (images.length) {
      // Une image se joint au texte du même tour, en PARTIES : le texte d'abord, puis les images.
      out.push({
        role: "user",
        content: [
          ...(text ? [{ type: "text" as const, text: sanitizeForModel(text) }] : []),
          ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mime};base64,${i.data}`, ...(i.detail ? { detail: i.detail } : {}) } })),
        ],
      });
    } else if (text) out.push({ role: "user", content: sanitizeForModel(text) });
  }

  return out;
}

/** La réponse du fournisseur → les blocs NEUTRES. */
export function toBlocks(msg: OaMessage | undefined): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  const brut = msg?.content;
  const text = (typeof brut === "string" ? brut : Array.isArray(brut) ? brut.map((p) => (p.type === "text" ? p.text : "")).join("") : "").trim();
  if (text) blocks.push({ type: "text", text });
  for (const [i, call] of (msg?.tool_calls ?? []).entries()) {
    const name = call.function?.name;
    if (!name) continue;
    blocks.push({
      type: "tool_call",
      // Un identifiant manquant rendrait le résultat impossible à rattacher : on en fabrique un
      // stable plutôt que de perdre l'appel.
      id: call.id || `call_${i}`,
      name,
      args: parseToolArgs(call.function?.arguments),
    });
  }
  return blocks;
}

/**
 * LE PLAFOND D'OUTILS DE L'API — une contrainte du fournisseur, pas un réglage.
 *
 * OpenAI refuse une requête portant plus de 128 outils, avec un 400 :
 * « Invalid 'tools': array too long. Expected an array with maximum length 128 ».
 *
 * ── CE QUE CE PLAFOND A COÛTÉ ────────────────────────────────────────────────────────────
 *
 * Rien ne le vérifiait. La liste complète d'un Super Admin en compte 161 (11 lecture + 79
 * pouvoirs + 1 export + 2 + 9 super-admin + 29 écriture + 30 domaines), et le chemin LEGACY —
 * qui reçoit 80 % des lectures et LA TOTALITÉ des mutations — l'envoyait telle quelle. Adam
 * répondait « Erreur IA (HTTP 400) » à « Hello ». Pas dans un cas limite : dans le cas courant.
 *
 * ── POURQUOI LA GARDE EST ICI ────────────────────────────────────────────────────────────
 *
 * Parce que c'est ici qu'on parle OpenAI. Une limite du fournisseur se fait respecter à la
 * frontière du fournisseur, sinon chaque appelant doit s'en souvenir — et il suffit qu'un seul
 * l'oublie pour que la production tombe. C'est un FILET, pas la solution : couper la liste fait
 * perdre des capacités en silence, donc l'appelant doit réduire AVANT, de façon réversible
 * (voir `shortlistTools`, que la découverte peut rouvrir en cours de boucle).
 *
 * La coupe garde les PREMIERS : l'ordre de la liste est significatif pour le modèle, et les
 * outils de lecture et de pouvoir sont assemblés avant les schémas de domaine.
 */
export const MAX_TOOLS_PER_CALL = 128;

/** Applique le plafond en le DISANT. Un dépassement est un défaut d'assemblage, pas un détail. */
export function capTools<T extends { name: string }>(tools: T[]): T[] {
  if (tools.length <= MAX_TOOLS_PER_CALL) return tools;
  const perdus = tools.slice(MAX_TOOLS_PER_CALL).map((t) => t.name);
  console.error(
    `[models] ${tools.length} outils demandés, plafond ${MAX_TOOLS_PER_CALL} — `
    + `${perdus.length} écartés à la frontière : ${perdus.join(", ")}. `
    + "L'appelant aurait dû réduire la liste lui-même (liste courte réversible).",
  );
  return tools.slice(0, MAX_TOOLS_PER_CALL);
}

/** Le corps de la requête. Séparé de l'envoi pour être testable sans réseau. */
export function buildBody(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions,
): Record<string, unknown> {
  const reasoning = opts.reasoning ?? binding.reasoning;
  return {
    model: opts.modelOverride || binding.model,
    messages: toOpenAiMessages(turns, opts.system),
    max_completion_tokens: opts.maxOutputTokens ?? 2000,
    reasoning_effort: reasoning,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.tools?.length
      ? {
          tools: capTools(opts.tools).map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(opts.jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
          },
        }
      : {}),
  };
}

/**
 * UN APPEL. Ne lève jamais : toute panne revient en `ModelReply` avec `ok: false`, parce qu'une
 * exception qui traverse une boucle d'agent perd l'usage déjà consommé — donc le coût déjà payé.
 */
export async function callOpenAi(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions = {},
): Promise<ModelReply> {
  const started = Date.now();
  const key = cleOpenAI();
  if (!key) {
    return reponseSansCle(binding, "openai", "OPENAI_API_KEY");
  }

  const body = buildBody(binding, turns, opts);

  let lastError = "Appel au modèle impossible (réseau).";
  let droppedTemperature = false;
  let grewBudget = false;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(urlOpenAI("/chat/completions"), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });

      // La porte de concurrence écoute les soldes et les 429 — même règle que sur Responses.
      noterEnTetes(res.headers);
      if (res.status === 429) noter429(res.headers.get("retry-after"), res.headers.get("x-ratelimit-reset-requests"));

      if (res.ok) {
        noterSucces();
        const data = (await res.json()) as OaResponse;
        const choice = data.choices?.[0];
        const blocks = toBlocks(choice?.message);
        const inputTokens = data.usage?.prompt_tokens ?? 0;
        const outputTokens = data.usage?.completion_tokens ?? 0;

        // LE PIÈGE DE LA RÉPONSE VIDE (voir l'en-tête) : rien à dire, aucun outil appelé, et le
        // budget de sortie épuisé par la réflexion interne. On rejoue UNE fois, budget triplé.
        if (!blocks.length && choice?.finish_reason === "length" && !grewBudget) {
          grewBudget = true;
          const current = Number(body.max_completion_tokens ?? 2000);
          body.max_completion_tokens = current * 3;
          console.warn(
            `[models] ${binding.role}/${binding.model} — réponse vide (finish_reason=length), budget ${current} → ${current * 3}`,
          );
          continue;
        }

        return {
          ok: true,
          configured: true,
          stop: stopOf(choice?.finish_reason, blocks.some((b) => b.type === "tool_call")),
          blocks,
          usage: {
            role: binding.role,
            model: binding.model,
            provider: "openai",
            inputTokens,
            outputTokens,
            cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            costUsd: costOf(binding, inputTokens, outputTokens, data.usage?.prompt_tokens_details?.cached_tokens ?? 0),
            ms: Date.now() - started,
            attempts: attempt,
          },
        };
      }

      const raw = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      lastError = providerErrorMessage(res.status, raw);

      // PARAMÈTRE REFUSÉ PAR LE MODÈLE. Un 400 sur `temperature` n'est pas une panne : c'est un
      // modèle qui ne connaît pas ce réglage. On le retire et on rejoue — sinon un rôle entier
      // tombe pour un paramètre optionnel.
      if (res.status === 400 && !droppedTemperature && mentionsUnsupportedTemperature(raw)) {
        droppedTemperature = true;
        delete body.temperature;
        continue;
      }

      // ── CE QUI SE TROUVAIT ICI, ET POURQUOI IL A ÉTÉ RETIRÉ ──────────────────────────────
      //
      // Un second rattrapage retirait `reasoning_effort` dès qu'un 400 le mentionnait. L'idée
      // paraissait symétrique de celle du dessus ; elle ne l'était pas.
      //
      // Le message qui a fait tomber la production le mentionne :
      //
      //   « Function tools with reasoning_effort are not supported for gpt-5.6-terra in
      //     /v1/chat/completions. To use function tools, use /v1/responses OU set
      //     reasoning_effort to 'none'. »
      //
      // Le rattrapage prenait donc la seconde branche du OU — silencieusement. Quand il
      // réussissait, Adam rendait une réponse RAISONNÉE MOINS QUE DEMANDÉ sans que rien ne
      // l'indique, sur les demandes de niveau C, celles-là mêmes qui ne valent que par le
      // raisonnement. Une panne visible aurait été moins coûteuse qu'une réponse dégradée qui
      // a l'air d'avoir marché.
      //
      // La bonne branche du OU est la PREMIÈRE : changer de porte. C'est ce que fait désormais
      // `protocol.ts`, avant l'appel plutôt qu'après l'échec.

      console.error("[models] openai error", binding.role, binding.model, res.status, raw.slice(0, 300));
      if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) break;
    } catch (err) {
      if (opts.signal?.aborted) {
        lastError = "Appel interrompu.";
        break;
      }
      console.error(`[models] openai call failed (${binding.role}, tentative ${attempt})`, err);
      lastError = "Appel au modèle impossible (réseau ou délai dépassé).";
      if (attempt === MAX_ATTEMPTS) break;
    }
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }

  return reponseEnEchec(binding, "openai", started, lastError);
}

// ─────────────────────────────── Streaming ───────────────────────────────

/**
 * ACCUMULATEUR DE FRAGMENTS. Le texte arrive par morceaux, mais les APPELS D'OUTILS aussi : le
 * nom dans un fragment, les arguments répartis sur les suivants, identifiés par leur INDEX et
 * pas par leur identifiant (qui n'arrive qu'une fois). Reconstituer par index est la seule façon
 * de ne pas perdre un appel d'outil sur une réponse qui en émet plusieurs.
 */
export class StreamAssembler {
  private text = "";
  private calls = new Map<number, { id: string; name: string; args: string }>();
  finish: string | undefined;

  push(delta: { content?: string | null; tool_calls?: OaToolCall[] }, finishReason?: string): string {
    if (finishReason) this.finish = finishReason;
    for (const call of delta.tool_calls ?? []) {
      const idx = call.index ?? 0;
      const acc = this.calls.get(idx) ?? { id: "", name: "", args: "" };
      if (call.id) acc.id = call.id;
      if (call.function?.name) acc.name = call.function.name;
      if (call.function?.arguments) acc.args += call.function.arguments;
      this.calls.set(idx, acc);
    }
    const chunk = delta.content ?? "";
    if (chunk) this.text += chunk;
    return chunk;
  }

  blocks(): ModelBlock[] {
    const out: ModelBlock[] = [];
    if (this.text.trim()) out.push({ type: "text", text: this.text.trim() });
    for (const [idx, c] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue;
      out.push({ type: "tool_call", id: c.id || `call_${idx}`, name: c.name, args: parseToolArgs(c.args) });
    }
    return out;
  }

  hasCalls(): boolean {
    return [...this.calls.values()].some((c) => c.name);
  }
}

/**
 * APPEL EN FLUX. Le texte remonte au fil de l'eau ; le résultat final a exactement la même forme
 * que `callOpenAi`, pour que la boucle d'agent n'ait pas deux chemins à connaître.
 *
 * Aucun réessai ici, volontairement : une fois qu'un caractère s'est affiché, on ne peut pas
 * rejouer proprement. L'appelant peut retomber sur `callOpenAi` si l'échec précède le premier
 * caractère.
 */
export async function streamOpenAi(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions,
  onText: (chunk: string) => void,
): Promise<ModelReply> {
  const started = Date.now();
  const key = cleOpenAI();
  if (!key) {
    return reponseSansCle(binding, "openai", "OPENAI_API_KEY");
  }

  const body = { ...buildBody(binding, turns, opts), stream: true, stream_options: { include_usage: true } };
  const asm = new StreamAssembler();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  try {
    const res = await fetch(urlOpenAI("/chat/completions"), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[models] openai stream error", binding.role, res.status, raw.slice(0, 300));
      return reponseEnEchec(binding, "openai", started, providerErrorMessage(res.status, raw));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE : des événements séparés par une ligne vide, chacun préfixé par `data: `.
      let cut: number;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null; tool_calls?: OaToolCall[] }; finish_reason?: string }[];
            usage?: OaResponse["usage"];
          };
          const choice = evt.choices?.[0];
          if (choice?.delta) {
            const chunk = asm.push(choice.delta, choice.finish_reason);
            if (chunk) onText(chunk);
          } else if (choice?.finish_reason) {
            asm.push({}, choice.finish_reason);
          }
          if (evt.usage) {
            inputTokens = evt.usage.prompt_tokens ?? inputTokens;
            outputTokens = evt.usage.completion_tokens ?? outputTokens;
            cachedInputTokens = evt.usage.prompt_tokens_details?.cached_tokens ?? cachedInputTokens;
          }
        } catch {
          /* fragment SSE illisible — on continue, le flux reste exploitable */
        }
      }
    }

    const blocks = asm.blocks();
    return {
      ok: true,
      configured: true,
      stop: stopOf(asm.finish, asm.hasCalls()),
      blocks,
      usage: {
        role: binding.role,
        model: binding.model,
        provider: "openai",
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd: costOf(binding, inputTokens, outputTokens, cachedInputTokens),
        ms: Date.now() - started,
        attempts: 1,
      },
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      // Interruption VOULUE (barge-in vocal, client parti) : ce n'est pas une panne, et ce qui a
      // déjà été dit reste valable.
      return {
        ok: true,
        configured: true,
        stop: "end",
        blocks: asm.blocks(),
        usage: {
          ...emptyUsage(binding.role, binding.model, "openai"),
          inputTokens,
          outputTokens,
          ms: Date.now() - started,
          attempts: 1,
        },
      };
    }
    console.error("[models] openai stream failed", binding.role, err);
    return reponseEnEchec(binding, "openai", started, "Appel au modèle impossible (réseau ou délai dépassé).");
  }
}
