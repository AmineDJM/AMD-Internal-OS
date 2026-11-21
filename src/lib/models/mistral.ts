import { emptyUsage, type ModelCallOptions, type ModelReply, type ModelRole, type ModelTurn } from "./contract";
import { attendu } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MISTRAL EN SECOURS (Direction, 19-21/11/2026 : « prends un modèle déjà utilisé par la plateforme »).
 *
 * La clé `MISTRAL_API_KEY` sert déjà à l'OCR des dossiers réglementaires (`regulatory/intelligence/ocr/mistral-ocr.ts`) :
 * le fournisseur est connu de la plateforme, et les documents qu'on lui envoie en sont déjà. Ici, la même clé sert la
 * CONVERSATION de Mistral (`POST https://api.mistral.ai/v1/chat/completions`, compatible OpenAI) quand le fournisseur en
 * service échoue : texte, images (pages d'un devis scanné) et JSON imposé par schéma. Sans outils — un tour à outils
 * n'a pas ce secours.
 *
 *   clé     `MISTRAL_API_KEY` — jamais lue par un modèle, jamais journalisée, jamais renvoyée ;
 *   base    `MISTRAL_BASE_URL`, défaut `https://api.mistral.ai/v1` ;
 *   modèle  `MISTRAL_MODEL_SECOURS`, défaut `mistral-medium-latest` (texte et images) ;
 *   tarif   non posé dans la grille : coût INCONNU (`null`), jamais deviné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MISTRAL_BASE_DEFAUT = "https://api.mistral.ai/v1";
export const MISTRAL_MODELE_DEFAUT = "mistral-medium-latest";

export function configMistral(env: Record<string, string | undefined> = process.env) {
  return {
    cle: env.MISTRAL_API_KEY?.trim() || null,
    base: (env.MISTRAL_BASE_URL?.trim() || MISTRAL_BASE_DEFAUT).replace(/\/+$/, ""),
    modele: env.MISTRAL_MODEL_SECOURS?.trim() || MISTRAL_MODELE_DEFAUT,
  };
}

export const mistralDisponible = (env: Record<string, string | undefined> = process.env): boolean => configMistral(env).cle !== null;

/** Une erreur dite SANS la clé. */
const expurger = (t: string) => t.replace(/Bearer\s+\S+/gi, "Bearer «clé»").replace(/[A-Za-z0-9]{32,}/g, "«clé»").slice(0, 300);

/** Les tours au format de Mistral : le système, puis texte et images (`image_url` en adresse `data:`). */
export function messagesMistral(turns: ModelTurn[], opts: ModelCallOptions): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = opts.system ? [{ role: "system", content: opts.system }] : [];
  for (const t of turns) {
    if (typeof t.content === "string") { out.push({ role: t.role, content: t.content }); continue; }
    const parts = t.content.flatMap((b): unknown[] => {
      if (b.type === "text") return [{ type: "text", text: b.text }];
      if (b.type === "image") return [{ type: "image_url", image_url: `data:${b.mime};base64,${b.data}` }];
      return [];
    });
    out.push({ role: t.role, content: parts });
  }
  return out;
}

const AVEC_OUTILS = (turns: ModelTurn[], opts: ModelCallOptions) =>
  Boolean(opts.tools?.length) || turns.some((t) => typeof t.content !== "string" && t.content.some((b) => b.type === "tool_call" || b.type === "tool_result"));

export async function appelerMistralTours(
  role: ModelRole, turns: ModelTurn[], opts: ModelCallOptions = {},
  deps: { fetch?: typeof fetch; env?: Record<string, string | undefined>; delaiMs?: number } = {},
): Promise<ModelReply> {
  const c = configMistral(deps.env);
  const debut = Date.now();
  const echec = (erreur: string, configure = true): ModelReply => ({
    ok: false, configured: configure, stop: "error", blocks: [], error: erreur,
    usage: { ...emptyUsage(role, c.modele, "mistral"), ms: Date.now() - debut },
  });
  if (!c.cle) return echec("Mistral non configuré (variable MISTRAL_API_KEY absente)", false);
  if (AVEC_OUTILS(turns, opts)) return echec("Le secours Mistral ne porte pas les outils.");
  const corpsRequete: Record<string, unknown> = {
    model: c.modele, messages: messagesMistral(turns, opts), max_tokens: opts.maxOutputTokens ?? 4_000, stream: false,
    ...(opts.jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true } } }
      : {}),
  };
  let r: Response;
  try {
    r = await (deps.fetch ?? fetch)(`${c.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.cle}` },
      body: JSON.stringify(corpsRequete),
      signal: opts.signal ?? AbortSignal.timeout(deps.delaiMs ?? opts.timeoutMs ?? 120_000),
    });
  } catch (e) {
    return echec(`Mistral injoignable : ${expurger(e instanceof Error ? e.message : String(e))}`);
  }
  const corps = (await r.json().catch(attendu("réponse Mistral non JSON : traitée comme vide", null))) as {
    choices?: { message?: { content?: string | { type?: string; text?: string }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    message?: string; error?: { message?: string } | string; detail?: unknown;
  } | null;
  const ms = Date.now() - debut;
  if (!r.ok) {
    const msg = typeof corps?.error === "string" ? corps.error : corps?.error?.message ?? corps?.message ?? "";
    return echec(`Mistral HTTP ${r.status}${msg ? ` : ${expurger(msg)}` : ""}`);
  }
  const brut = corps?.choices?.[0]?.message?.content;
  const texte = (typeof brut === "string" ? brut : (brut ?? []).map((p) => p.text ?? "").join("")).trim();
  if (!texte) return echec("Mistral a rendu une réponse vide");
  return {
    ok: true, configured: true, stop: corps?.choices?.[0]?.finish_reason === "length" ? "length" : "end",
    blocks: [{ type: "text", text: texte }],
    usage: {
      ...emptyUsage(role, c.modele, "mistral"),
      inputTokens: corps?.usage?.prompt_tokens ?? 0, outputTokens: corps?.usage?.completion_tokens ?? 0, costUsd: null, ms, attempts: 1,
    },
  };
}
