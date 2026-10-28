/**
 * Adaptateur Responses — LE FLUX : l'accumulateur d'événements typés (`ResponsesStreamAssembler`)
 * et l'appel en flux (`streamOpenAiResponses`).
 */
import { providerErrorMessage } from "../errors";
import { noterEnTetes, noter429, noterSucces } from "../throttle";
import { type ModelBinding, type ModelBlock, type ModelCallOptions, type ModelReply, type ModelTurn, emptyUsage } from "../contract";
import { attendu } from "@/lib/journal";
import { buildResponsesBody, fromResponsesOutput, lireRecherchesWeb, parseArgs, type RespFunctionCall, type RespOutputItem, type RespPayload, type RespUsage, type RespWebSearchCall, sansCle, stopOfResponse, urlDe } from "./format";
import { journaliserBudget, usageDe } from "./usage";

// ─────────────────────────────── Le flux ───────────────────────────────

/**
 * ACCUMULATEUR D'ÉVÉNEMENTS RESPONSES.
 *
 * Le flux ne rend pas des fragments de message : il rend des événements TYPÉS, chacun désignant
 * l'élément de sortie qu'il complète par son `output_index`. Un appel d'outil arrive donc en deux
 * temps — son identité (`output_item.added`), puis ses arguments par morceaux — et deux appels
 * concurrents s'entrelacent. Les regrouper par index est la seule façon de n'en perdre aucun.
 */
export class ResponsesStreamAssembler {
  private texte = "";
  private appels = new Map<number, { callId: string; name: string; args: string }>();
  private recherchesWeb = 0;
  private citations = new Map<string, string | null>();
  statut: string | undefined;
  raison: string | undefined;
  responseId: string | undefined;

  /** Traite un événement. Rend le fragment de TEXTE à afficher, s'il y en a un. */
  push(evt: Record<string, unknown>): string {
    const type = String(evt.type ?? "");

    if (type === "response.output_text.delta") {
      const chunk = String(evt.delta ?? "");
      this.texte += chunk;
      return chunk;
    }

    if (type === "response.output_item.added") {
      const item = evt.item as RespFunctionCall | RespWebSearchCall | undefined;
      if (item?.type === "function_call") {
        const idx = Number(evt.output_index ?? 0);
        const acc = this.appels.get(idx) ?? { callId: "", name: "", args: "" };
        if (item.call_id) acc.callId = item.call_id;
        if (item.name) acc.name = item.name;
        if (item.arguments) acc.args = item.arguments;
        this.appels.set(idx, acc);
      }
      // Une recherche web annoncée dans le flux — elle se compte dès son apparition : c'est le
      // filet quand l'événement final (qui porte l'état complet) se perd en route.
      if (item?.type === "web_search_call") this.recherchesWeb++;
      return "";
    }

    if (type === "response.output_text.annotation.added") {
      const a = evt.annotation as { type?: string; url?: string; title?: string } | undefined;
      if (a?.type === "url_citation" && a.url && !this.citations.has(a.url)) {
        this.citations.set(a.url, a.title?.trim() || null);
      }
      return "";
    }

    if (type === "response.function_call_arguments.delta") {
      const idx = Number(evt.output_index ?? 0);
      const acc = this.appels.get(idx) ?? { callId: "", name: "", args: "" };
      acc.args += String(evt.delta ?? "");
      this.appels.set(idx, acc);
      return "";
    }

    if (type === "response.function_call_arguments.done") {
      const idx = Number(evt.output_index ?? 0);
      const acc = this.appels.get(idx) ?? { callId: "", name: "", args: "" };
      // La forme complète fait foi sur l'accumulation : un fragment perdu ne se voit pas.
      if (typeof evt.arguments === "string") acc.args = evt.arguments;
      this.appels.set(idx, acc);
      return "";
    }

    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const payload = evt.response as RespPayload | undefined;
      this.statut = payload?.status ?? type.slice("response.".length);
      this.raison = payload?.incomplete_details?.reason;
      this.responseId = payload?.id;
    }

    return "";
  }

  blocks(): ModelBlock[] {
    const out: ModelBlock[] = [];
    if (this.texte.trim()) out.push({ type: "text", text: this.texte.trim() });
    for (const [idx, a] of [...this.appels.entries()].sort((x, y) => x[0] - y[0])) {
      if (!a.name) continue;
      out.push({ type: "tool_call", id: a.callId || `call_${idx}`, name: a.name, args: parseArgs(a.args) });
    }
    return out;
  }

  hasCalls(): boolean {
    return [...this.appels.values()].some((a) => a.name);
  }

  /** Les traces web accumulées — même forme que `lireRecherchesWeb`, pour le même usage. */
  web(): { recherches: number; sources: { url: string; title: string | null }[] } {
    return {
      recherches: this.recherchesWeb,
      sources: [...this.citations.entries()].map(([url, title]) => ({ url, title })),
    };
  }
}

/**
 * APPEL EN FLUX. Le texte remonte au fil de l'eau ; le résultat final a exactement la même forme
 * que `callOpenAiResponses`, pour que la boucle d'agent n'ait pas deux chemins à connaître.
 *
 * Aucun réessai, volontairement : une fois qu'un caractère s'est affiché, on ne peut pas rejouer.
 */
export async function streamOpenAiResponses(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions,
  onText: (chunk: string) => void,
): Promise<ModelReply> {
  const started = Date.now();
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return sansCle(binding);

  const body = { ...buildResponsesBody(binding, turns, opts), stream: true };
  const asm = new ResponsesStreamAssembler();
  let usage: RespUsage | undefined;
  let sortieFinale: RespOutputItem[] | undefined;

  try {
    const res = await fetch(urlDe(), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });

    // Même écoute que l'appel simple : le flux est un appel comme un autre pour la porte.
    noterEnTetes(res.headers);
    if (res.status === 429) noter429(res.headers.get("retry-after"), res.headers.get("x-ratelimit-reset-requests"));
    if (res.ok) noterSucces();

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[models] openai responses stream error", binding.role, res.status, raw.slice(0, 300));
      return {
        ok: false,
        configured: true,
        stop: "error",
        blocks: [],
        usage: { ...emptyUsage(binding.role, binding.model, "openai"), ms: Date.now() - started },
        error: providerErrorMessage(res.status, raw),
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE. Les lignes `event:` sont ignorées : la charge utile porte déjà son propre `type`,
      // et se fier à un seul des deux évite qu'un désaccord entre eux passe inaperçu.
      let cut: number;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          const chunk = asm.push(evt);
          if (chunk) onText(chunk);
          const fin = evt.response as RespPayload | undefined;
          if (fin?.usage) usage = fin.usage;
          if (fin?.output?.length) sortieFinale = fin.output;
        } catch {
          /* fragment SSE illisible — on continue, le flux reste exploitable */
        }
      }
    }

    // LA SORTIE FINALE FAIT FOI QUAND ELLE ARRIVE. `response.completed` porte l'état complet ;
    // s'y fier ferme le cas où un fragment d'événement s'est perdu en route, et l'accumulateur
    // reste le filet quand l'événement final manque (flux coupé, proxy bavard).
    const blocks = sortieFinale ? fromResponsesOutput(sortieFinale) : asm.blocks();
    // La sortie finale fait foi aussi pour le web — l'accumulateur reste le filet.
    const web = sortieFinale ? lireRecherchesWeb(sortieFinale) : asm.web();
    const hasCalls = blocks.some((b) => b.type === "tool_call");
    const etat = { status: asm.statut, incomplete_details: { reason: asm.raison } };
    const plafond = Number((body as { max_output_tokens?: number }).max_output_tokens ?? 0) || null;

    // MÊME MESURE QU'EN APPEL SIMPLE. Le flux est le chemin de la conversation, donc celui où une
    // coupure de budget se voit le plus (une phrase s'arrête au milieu) et se diagnostique le
    // moins — il n'y a pas de `status` à lire à l'écran.
    journaliserBudget(binding, plafond, usage, etat);

    return {
      ok: asm.statut !== "failed",
      configured: true,
      stop: stopOfResponse(etat, hasCalls),
      blocks,
      usage: usageDe(binding, usage, started, 1, {
        maxOutputTokens: plafond,
        incompleteReason: asm.statut === "incomplete" ? (asm.raison ?? "incomplete") : null,
        webSearchCalls: web.recherches,
      }),
      ...(asm.responseId ? { responseId: asm.responseId } : {}),
      ...(web.sources.length ? { webSources: web.sources } : {}),
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
        usage: usageDe(binding, usage, started, 1),
      };
    }
    console.error("[models] openai responses stream failed", binding.role, err);
    return {
      ok: false,
      configured: true,
      stop: "error",
      blocks: [],
      usage: { ...emptyUsage(binding.role, binding.model, "openai"), ms: Date.now() - started },
      error: "Appel au modèle impossible (réseau ou délai dépassé).",
    };
  }
}
