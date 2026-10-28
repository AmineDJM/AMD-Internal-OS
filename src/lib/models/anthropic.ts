import { sanitizeForModel } from "@/lib/ai-text";
import { providerErrorMessage, isRetryableStatus } from "./errors";
import {
  type ModelBinding,
  type ModelBlock,
  type ModelCallOptions,
  type ModelReply,
  type ModelStop,
  type ModelToolDef,
  type ModelTurn,
  costOf,
  emptyUsage,
} from "./contract";
import { attendu } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR ANTHROPIC — la marche arrière, et rien d'autre.
 *
 * ── POURQUOI CE CHEMIN EXISTE ENCORE ─────────────────────────────────────────────────────
 *
 * Une migration de cerveau sans retour possible n'est pas une migration, c'est un pari.
 * `ADAM_MODEL_PROVIDER=anthropic` rebascule les rôles textuels en une variable d'environnement,
 * sans redéploiement. Le rôle `realtime` ne bascule jamais : il n'a pas d'équivalent ici.
 *
 * ── POURQUOI IL N'APPELLE PAS `src/lib/ai.ts` ────────────────────────────────────────────
 *
 * C'était la version courte : traduire vers `callClaude`, qui marche déjà. Mais `src/lib/models/`
 * revendique d'être la partie d'Adam qu'il emporte avec lui — et un module qui prétend être
 * portable tout en important le client de l'ERP ne l'est pas. La propriété se vérifie
 * (`models-portable.test.ts`), donc elle doit être vraie, pas seulement affichée.
 *
 * Ce qui est porté ici est le CLIENT, pas la logique : mêmes en-têtes, même politique de
 * réessai, et surtout le même point de cache sur le préfixe stable — voir plus bas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** Forme neutre → forme Anthropic. */
export function toAnthropicMessages(turns: ModelTurn[]): { role: string; content: unknown }[] {
  return turns.map((t) => ({
    role: t.role,
    content:
      typeof t.content === "string"
        ? sanitizeForModel(t.content)
        : t.content
            .map((b): AnthropicBlock | null => {
              if (b.type === "text") return { type: "text", text: sanitizeForModel(b.text) };
              if (b.type === "tool_call") return { type: "tool_use", id: b.id, name: b.name, input: b.args ?? {} };
              if (b.type === "image") return { type: "image", source: { type: "base64", media_type: b.mime, data: b.data } };
              return {
                type: "tool_result",
                tool_use_id: b.callId,
                content: sanitizeForModel(b.content),
                ...(b.isError ? { is_error: true } : {}),
              };
            })
            .filter((b): b is AnthropicBlock => b !== null),
  }));
}

export function toAnthropicTools(tools: ModelToolDef[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/** Forme Anthropic → forme neutre. Les `tool_result` n'apparaissent jamais en SORTIE. */
export function fromAnthropicBlocks(blocks: AnthropicBlock[] | undefined): ModelBlock[] {
  const out: ModelBlock[] = [];
  for (const b of blocks ?? []) {
    if (!b) continue;
    if (b.type === "text" && b.text.trim()) out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_call", id: b.id, name: b.name, args: b.input ?? {} });
  }
  return out;
}

export function stopOfAnthropic(reason: string | undefined, hasCalls: boolean): ModelStop {
  if (hasCalls) return "tools";
  switch (reason) {
    case "tool_use":
      return "tools";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
      return "end";
    default:
      return reason ? "end" : "error";
  }
}

/**
 * Le corps de la requête.
 *
 * LE POINT DE CACHE sur le bloc `system` n'est pas un détail de coût : dans l'ordre de rendu
 * (outils → système → messages), il couvre AUSSI les définitions d'outils. Une boucle d'agent
 * rappelle l'API plusieurs fois avec exactement le même préfixe ; sans ce point, on le repaie et
 * surtout on le re-traite à chaque tour — c'est de la latence pure, celle qui se voit.
 */
export function buildAnthropicBody(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions,
  stream = false,
): Record<string, unknown> {
  const tools = toAnthropicTools(opts.tools);
  return {
    model: opts.modelOverride || binding.model,
    max_tokens: opts.maxOutputTokens ?? 1400,
    temperature: opts.temperature ?? 0.2,
    ...(stream ? { stream: true } : {}),
    ...(opts.system
      ? { system: [{ type: "text", text: sanitizeForModel(opts.system), cache_control: { type: "ephemeral" } }] }
      : {}),
    ...(tools ? { tools } : {}),
    messages: toAnthropicMessages(turns),
  };
}

const headers = (key: string) => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

const baseUrl = () => (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

function notConfigured(binding: ModelBinding): ModelReply {
  return {
    ok: false,
    configured: false,
    stop: "error",
    blocks: [],
    usage: emptyUsage(binding.role, binding.model, "anthropic"),
    error: "Clé ANTHROPIC_API_KEY non configurée.",
  };
}

export async function callAnthropic(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions = {},
): Promise<ModelReply> {
  const started = Date.now();
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) return notConfigured(binding);

  const payload = JSON.stringify(buildAnthropicBody(binding, turns, opts));
  let lastError = "Appel au modèle impossible (réseau).";
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/v1/messages`, {
        method: "POST",
        headers: headers(key),
        body: payload,
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          content?: AnthropicBlock[];
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
        };
        const blocks = fromAnthropicBlocks(data.content);
        const inputTokens = data.usage?.input_tokens ?? 0;
        const outputTokens = data.usage?.output_tokens ?? 0;
        return {
          ok: true,
          configured: true,
          stop: stopOfAnthropic(data.stop_reason, blocks.some((b) => b.type === "tool_call")),
          blocks,
          usage: {
            role: binding.role,
            model: binding.model,
            provider: "anthropic",
            inputTokens,
            outputTokens,
            cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0,
            costUsd: costOf(binding, inputTokens, outputTokens, data.usage?.cache_read_input_tokens ?? 0),
            ms: Date.now() - started,
            attempts: attempt,
          },
        };
      }

      const body = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[models] anthropic error", binding.role, res.status, body.slice(0, 300));
      lastError = providerErrorMessage(res.status, body);
      if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) break;
    } catch (err) {
      if (opts.signal?.aborted) {
        lastError = "Appel interrompu.";
        break;
      }
      console.error(`[models] anthropic call failed (${binding.role}, tentative ${attempt})`, err);
      lastError = "Appel au modèle impossible (réseau ou délai dépassé).";
      if (attempt === MAX_ATTEMPTS) break;
    }
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }

  return {
    ok: false,
    configured: true,
    stop: "error",
    blocks: [],
    usage: { ...emptyUsage(binding.role, binding.model, "anthropic"), ms: Date.now() - started },
    error: lastError,
  };
}

/**
 * APPEL EN FLUX.
 *
 * Le texte arrive par fragments, et l'ENTRÉE D'UN OUTIL aussi — en JSON partiel, à concaténer
 * avant d'être analysée. C'est le piège de ce format : un `JSON.parse` sur un fragment échoue
 * silencieusement et fait perdre l'appel d'outil, donc l'action.
 */
export async function streamAnthropic(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions,
  onText: (chunk: string) => void,
): Promise<ModelReply> {
  const started = Date.now();
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) return notConfigured(binding);

  const blocks: AnthropicBlock[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  const finish = (ok: boolean, error?: string): ModelReply => {
    const neutral = fromAnthropicBlocks(blocks.filter(Boolean));
    return {
      ok,
      configured: true,
      stop: ok ? stopOfAnthropic(stopReason, neutral.some((b) => b.type === "tool_call")) : "error",
      blocks: ok ? neutral : [],
      usage: {
        role: binding.role,
        model: binding.model,
        provider: "anthropic",
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd: costOf(binding, inputTokens, outputTokens, cachedInputTokens),
        ms: Date.now() - started,
        attempts: 1,
      },
      ...(error ? { error } : {}),
    };
  };

  try {
    const res = await fetch(`${baseUrl()}/v1/messages`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(buildAnthropicBody(binding, turns, opts, true)),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[models] anthropic stream error", binding.role, res.status, body.slice(0, 300));
      return finish(false, providerErrorMessage(res.status, body));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = evt.type;
        const index = typeof evt.index === "number" ? evt.index : 0;

        if (type === "message_start") {
          const msg = evt.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number } } | undefined;
          inputTokens = msg?.usage?.input_tokens ?? inputTokens;
          cachedInputTokens = msg?.usage?.cache_read_input_tokens ?? cachedInputTokens;
        } else if (type === "content_block_start") {
          const block = evt.content_block as AnthropicBlock | undefined;
          if (block) {
            blocks[index] = block.type === "text" ? { type: "text", text: "" } : block;
            if (block.type === "tool_use") partialJson.set(index, "");
          }
        } else if (type === "content_block_delta") {
          const delta = evt.delta as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const b = blocks[index];
            if (b && b.type === "text") b.text += delta.text;
            onText(delta.text);
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            partialJson.set(index, (partialJson.get(index) ?? "") + delta.partial_json);
          }
        } else if (type === "content_block_stop") {
          const b = blocks[index];
          const json = partialJson.get(index);
          if (b && b.type === "tool_use" && json !== undefined) {
            try {
              b.input = json ? (JSON.parse(json) as Record<string, unknown>) : {};
            } catch {
              b.input = {};
            }
          }
        } else if (type === "message_delta") {
          const d = evt.delta as { stop_reason?: string } | undefined;
          if (d?.stop_reason) stopReason = d.stop_reason;
          const u = evt.usage as { output_tokens?: number } | undefined;
          outputTokens = u?.output_tokens ?? outputTokens;
        } else if (type === "error") {
          const e = evt.error as { message?: string } | undefined;
          return finish(false, e?.message ?? "Erreur IA pendant la génération.");
        }
      }
    }

    return finish(true);
  } catch (err) {
    // Interruption VOULUE : ce n'est pas une panne, et ce qui a déjà été dit reste valable.
    if (opts.signal?.aborted) return finish(true);
    console.error("[models] anthropic stream failed", binding.role, err);
    return finish(false, "Appel au modèle impossible (réseau ou délai dépassé).");
  }
}
