/**
 * Adaptateur Responses — LA TRADUCTION DU FORMAT : formes du fournisseur, tours → `input`,
 * corps de requête, sortie → réponse du contrat (`ModelReply`), recherches web et motif d'arrêt.
 * Aucun appel réseau ici.
 */
import { sanitizeForModel } from "@/lib/ai-text";
import { createHash } from "node:crypto";
import { capTools } from "../openai";
import { supportsParam, supportsWebSearch, type ParamName } from "../capabilities";
import { outputBudget } from "../budget";
import { type ModelBinding, type ModelBlock, type ModelCallOptions, type ModelReply, type ModelStop, type ModelTurn, emptyUsage } from "../contract";

// ─────────────────────────────── Les formes du fournisseur ───────────────────────────────

export interface RespFunctionCall {
  type: "function_call";
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface RespMessage {
  type: "message";
  role?: string;
  content?: {
    type?: string;
    text?: string;
    /** Les citations d'une réponse fondée sur le web — `url_citation` porte l'URL et le titre. */
    annotations?: { type?: string; url?: string; title?: string }[];
  }[];
}

interface RespReasoning {
  type: "reasoning";
}

/** Une recherche exécutée par le FOURNISSEUR — elle se compte (facturée à l'unité). */
export interface RespWebSearchCall {
  type: "web_search_call";
  id?: string;
  status?: string;
}

export type RespOutputItem = RespFunctionCall | RespMessage | RespReasoning | RespWebSearchCall | { type: string };

export interface RespUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  /**
   * LA VENTILATION DE LA SORTIE. `output_tokens` compte la réflexion AVEC la réponse ; ce détail
   * est le seul endroit où les deux se séparent. Sans lui, un appel qui a tout dépensé à penser et
   * un appel qui a rédigé trois pages ont exactement le même compteur.
   */
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface RespPayload {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { message?: string };
  output?: RespOutputItem[];
  usage?: RespUsage;
}

/** Un élément d'entrée. Trois formes, exactement celles dont une boucle d'agent a besoin. */
type RespInputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" };

type RespInputItem =
  | { role: "user" | "assistant"; content: string | RespInputPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

// ─────────────────────────────── Entrée : neutre → Responses ───────────────────────────────

/**
 * LES TOURS NEUTRES → LES ÉLÉMENTS D'ENTRÉE.
 *
 * L'ORDRE EST LA CORRECTION, pas un détail de présentation. Un `function_call_output` qui
 * précéderait son `function_call` désigne un `call_id` que la conversation n'a pas encore vu :
 * le fournisseur refuse l'appel entier. C'est pourquoi les appels d'un tour assistant sont émis
 * AVANT le texte du tour suivant, et jamais regroupés en fin de liste.
 */
export function toResponsesInput(turns: ModelTurn[]): RespInputItem[] {
  const out: RespInputItem[] = [];

  for (const turn of turns) {
    if (typeof turn.content === "string") {
      const texte = sanitizeForModel(turn.content);
      if (texte) out.push({ role: turn.role, content: texte });
      continue;
    }

    const textes = turn.content.filter(
      (b): b is Extract<ModelBlock, { type: "text" }> => b.type === "text",
    );
    const appels = turn.content.filter(
      (b): b is Extract<ModelBlock, { type: "tool_call" }> => b.type === "tool_call",
    );
    const resultats = turn.content.filter(
      (b): b is Extract<ModelBlock, { type: "tool_result" }> => b.type === "tool_result",
    );

    if (turn.role === "assistant") {
      const texte = sanitizeForModel(textes.map((t) => t.text).join(""));
      if (texte) out.push({ role: "assistant", content: texte });
      for (const a of appels) {
        out.push({
          type: "function_call",
          call_id: a.id,
          name: a.name,
          arguments: JSON.stringify(a.args ?? {}),
        });
      }
      continue;
    }

    // Côté utilisateur : les résultats d'abord — ils répondent à ce qui précède — puis la parole.
    for (const r of resultats) {
      out.push({
        type: "function_call_output",
        call_id: r.callId,
        output: sanitizeForModel(r.isError ? `ERREUR : ${r.content}` : r.content),
      });
    }
    const texte = sanitizeForModel(textes.map((t) => t.text).join(""));
    const images = turn.content.filter((b): b is Extract<ModelBlock, { type: "image" }> => b.type === "image");
    if (images.length) {
      // Une image (§38) : le texte et les images du tour dans UN élément, en parties typées.
      out.push({
        role: "user",
        content: [
          ...(texte ? [{ type: "input_text" as const, text: texte }] : []),
          ...images.map((i) => ({ type: "input_image" as const, image_url: `data:${i.mime};base64,${i.data}`, ...(i.detail ? { detail: i.detail } : {}) })),
        ],
      });
    } else if (texte) out.push({ role: "user", content: texte });
  }

  return out;
}

/**
 * LE CORPS DE LA REQUÊTE — construit CHAMP PAR CHAMP, contre la fiche du modèle.
 *
 * ── POURQUOI CE N'EST PLUS UN OBJET LITTÉRAL ─────────────────────────────────────────────
 *
 * Avant, on écrivait l'objet complet et on espérait. C'est ainsi qu'y sont entrés
 * `reasoning_effort` sur la mauvaise porte, puis `temperature` sur un modèle qui le refuse :
 * rien, dans la forme du code, ne demandait « ce modèle-là accepte-t-il ce champ-là ? ».
 *
 * `poser()` pose cette question à chaque champ. Un paramètre absent de la liste blanche de
 * `capabilities.ts` n'est pas construit — donc jamais envoyé, donc jamais refusé. C'est une
 * garantie STRUCTURELLE, pas une vigilance : on ne peut plus ajouter un champ interdit sans
 * modifier d'abord le registre.
 *
 * ── CE QUI N'EST PLUS ENVOYÉ, ET CE QUI LE REMPLACE ──────────────────────────────────────
 *
 * `temperature`, `top_p`, `logprobs`, `top_logprobs` : SUPPRIMÉS, pas neutralisés. Terra les
 * refuse. Et l'on n'en a pas besoin — la précision d'Adam vient de l'effort de raisonnement, des
 * consignes, des sorties structurées, des outils typés, des données de l'ERP et de la validation
 * côté serveur. Régler la concision se fait désormais par `text.verbosity`, qui est le réglage
 * prévu pour ça et ne touche ni à la justesse ni au raisonnement.
 */
/**
 * LE PLANCHER DU FOURNISSEUR (§118.153). L'API Responses refuse un `max_output_tokens` inférieur à
 * 16 — « integer below minimum value. Expected a value >= 16 » — et ce refus est un 400 : l'appel
 * ENTIER échoue, pas seulement sa longueur. Mesuré en parcours réel : le diagnostic IA de
 * l'administration pingait avec 8 jetons, et l'écran du Super Admin annonçait « IA en panne »
 * pendant que le produit répondait — le faux négatif que l'en-tête de `aiSelfTest` décrit déjà
 * pour une autre cause, et qui fait corriger le mauvais problème.
 *
 * Il vit ICI, là où passent TOUS les appels vers ce fournisseur, et non chez l'appelant : réparer
 * le ping seul ne protégerait pas le prochain appel court (§118.58). Élever le plafond ne coûte
 * rien — c'est une borne, pas une consommation : la réponse ne s'allonge pas pour autant.
 */
export const PLANCHER_SORTIE_RESPONSES = 16;

export function buildResponsesBody(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions,
): Record<string, unknown> {
  const model = opts.modelOverride || binding.model;
  const reasoning = opts.reasoning ?? binding.reasoning;
  const chainage = Boolean(opts.previousResponseId);

  const body: Record<string, unknown> = {
    model,
    input: toResponsesInput(turns),
  };
  if (opts.system) body.instructions = sanitizeForModel(opts.system);

  /** Pose un champ SI et seulement si la fiche du modèle l'autorise. */
  const poser = (param: ParamName, cle: string, valeur: unknown): void => {
    if (valeur === undefined || valeur === null) return;
    if (!supportsParam(model, param)) return;
    body[cle] = valeur;
  };

  poser("reasoning", "reasoning", { effort: reasoning });
  // La passerelle a normalement DÉJÀ calculé ce plafond (réponse visible + réserve de
  // raisonnement) : il arrive donc ici tout fait. Le repli couvre l'usage direct de l'adaptateur —
  // essais, bancs — et passe par la MÊME politique, pour qu'il n'existe jamais deux façons de
  // choisir ce nombre.
  poser(
    "maxOutputTokens",
    "max_output_tokens",
    Math.max(
      PLANCHER_SORTIE_RESPONSES,
      opts.maxOutputTokens
        ?? outputBudget({
          role: binding.role,
          effort: reasoning,
          toolCount: opts.tools?.length ?? 0,
          requested: null,
          webSearch: Boolean(opts.webSearch),
        }).maxOutputTokens,
    ),
  );
  // Voir l'en-tête : on n'entrepose rien chez le fournisseur sans l'avoir demandé.
  poser("store", "store", chainage);
  if (chainage) poser("previousResponseId", "previous_response_id", opts.previousResponseId);

  if (opts.verbosity) poser("textVerbosity", "text", { verbosity: opts.verbosity });
  if (opts.jsonSchema) {
    // `text.format` et `text.verbosity` partagent le même objet : les poser séparément ferait
    // perdre le premier posé. On fusionne plutôt que d'écraser.
    const texte = (body.text as Record<string, unknown> | undefined) ?? {};
    poser("textFormat", "text", {
      ...texte,
      format: { type: "json_schema", name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
    });
  }

  // LES OUTILS SE COMPOSENT : nos fonctions ET, si l'appelant l'a demandé, l'outil `web_search`
  // du fournisseur. Le second n'est construit que si la fiche du modèle le porte — même règle
  // d'abstention que `poser` : ce qui n'est pas permis n'est pas fabriqué, donc jamais refusé.
  // (La passerelle, elle, REFUSE bruyamment un `webSearch` sur un modèle qui ne le porte pas —
  // l'abstention couvre l'usage direct de l'adaptateur, essais et bancs.)
  const outils: Record<string, unknown>[] = (opts.tools?.length ? capTools(opts.tools) : []).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  if (opts.webSearch && supportsWebSearch(model)) outils.push({ type: "web_search" });

  if (outils.length) {
    // La fonction n'est plus emboîtée : `{type, name, description, parameters}` à plat.
    poser("tools", "tools", outils);
    poser("toolChoice", "tool_choice", opts.toolChoice ?? "auto");
    // Plusieurs outils indépendants dans une seule réponse — la boucle les exécute de front.
    // Réservé aux FONCTIONS : le champ n'a pas de sens pour un outil fournisseur seul.
    if (opts.tools?.length) poser("parallelToolCalls", "parallel_tool_calls", true);
  }

  poser("safetyIdentifier", "safety_identifier", opts.safetyIdentifier);
  poser("promptCacheKey", "prompt_cache_key", opts.promptCacheKey);
  poser("include", "include", opts.include?.length ? opts.include : undefined);

  return body;
}

/**
 * LE BUDGET COUPÉ — détecté et NOMMÉ, plutôt que subi.
 *
 * `status: "incomplete"` avec `reason: "max_output_tokens"` ne veut pas dire « le modèle n'a pas
 * su répondre ». Cela veut dire « NOTRE plafond a coupé le modèle en plein travail » — un appel
 * payé pour rien, par une erreur de réglage de notre côté. Les deux se traitent à des endroits
 * opposés, et les confondre fait chercher la panne dans le modèle.
 */
export function budgetEpuise(payload: Pick<RespPayload, "status" | "incomplete_details">): boolean {
  return payload.status === "incomplete" && payload.incomplete_details?.reason === "max_output_tokens";
}

/**
 * L'IDENTIFIANT DE SÛRETÉ — un condensat, jamais l'identité.
 *
 * OpenAI s'en sert pour repérer les abus, et il sort de l'entreprise à chaque appel. Y mettre une
 * adresse e-mail exporterait l'annuaire d'Adventum un tour de conversation à la fois, pour une
 * fonction qui n'a besoin que de STABILITÉ : le même utilisateur doit produire le même jeton,
 * sans qu'on puisse remonter de ce jeton à la personne.
 *
 * Un sel d'installation (`ADAM_SAFETY_SALT`) empêche qu'un condensat nu, comparé à un
 * dictionnaire d'identifiants, redevienne une identité.
 */
export function safetyIdentifierFor(userId: string): string | undefined {
  const id = (userId ?? "").trim();
  if (!id) return undefined;
  const sel = (process.env.ADAM_SAFETY_SALT ?? "adam").trim();
  return createHash("sha256").update(`${sel}:${id}`).digest("hex").slice(0, 32);
}

// ─────────────────────────────── Sortie : Responses → neutre ───────────────────────────────

/**
 * ARGUMENTS D'UN APPEL D'OUTIL. Même règle que sur l'autre porte : le fournisseur rend une
 * chaîne, la boucle veut un objet, et un objet VIDE vaut mieux qu'un `null` qui plante trois
 * couches plus loin. Dupliqué depuis `openai.ts` plutôt qu'importé : les deux formats peuvent
 * diverger, et un correctif fait pour l'un ne doit pas s'appliquer à l'autre par surprise.
 */
export function parseArgs(raw: string | undefined): Record<string, unknown> {
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

/**
 * `output[]` → LES BLOCS NEUTRES.
 *
 * Les éléments `reasoning` sont IGNORÉS volontairement : ils portent la réflexion interne, que
 * la boucle d'agent n'a pas à relire et qu'on ne veut surtout pas afficher. Ils comptent dans
 * les jetons de sortie, et c'est là — dans l'usage — qu'ils restent visibles.
 */
export function fromResponsesOutput(output: RespOutputItem[] | undefined): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  let texte = "";

  for (const [i, item] of (output ?? []).entries()) {
    if (item.type === "message") {
      for (const part of (item as RespMessage).content ?? []) {
        if (part?.type === "output_text" && part.text) texte += part.text;
      }
      continue;
    }
    if (item.type === "function_call") {
      const call = item as RespFunctionCall;
      if (!call.name) continue;
      blocks.push({
        type: "tool_call",
        // `call_id` est celui qu'il faudra rendre ; `id` identifie l'élément. Confondre les deux
        // fait refuser le tour suivant, avec un message qui ne nomme pas la confusion.
        id: call.call_id || call.id || `call_${i}`,
        name: call.name,
        args: parseArgs(call.arguments),
      });
    }
  }

  // Le texte passe DEVANT : c'est ce que le modèle dit avant d'agir, et l'ordre est lu.
  return texte.trim() ? [{ type: "text", text: texte.trim() }, ...blocks] : blocks;
}

/**
 * LES TRACES D'UNE RECHERCHE WEB dans `output[]` — le compteur et les sources.
 *
 * Deux choses distinctes, et il faut les deux :
 *   • chaque élément `web_search_call` est une recherche EXÉCUTÉE — elle se FACTURE, qu'elle ait
 *     nourri la réponse ou non ;
 *   • chaque annotation `url_citation` du message est une page CITÉE — c'est elle qui rend la
 *     réponse vérifiable. Dédupliquée par URL : la même page citée trois fois est UNE source.
 *
 * `title` reste `null` quand le fournisseur n'en donne pas — on ne baptise pas une page à sa place.
 */
export function lireRecherchesWeb(output: RespOutputItem[] | undefined): {
  recherches: number;
  sources: { url: string; title: string | null }[];
} {
  let recherches = 0;
  const parUrl = new Map<string, string | null>();

  for (const item of output ?? []) {
    if (item.type === "web_search_call") {
      recherches++;
      continue;
    }
    if (item.type !== "message") continue;
    for (const part of (item as RespMessage).content ?? []) {
      for (const a of part?.annotations ?? []) {
        if (a?.type !== "url_citation" || !a.url) continue;
        // Le premier titre non vide gagne — jamais écrasé par un vide arrivé après.
        if (!parUrl.has(a.url) || (parUrl.get(a.url) == null && a.title)) {
          parUrl.set(a.url, a.title?.trim() || null);
        }
      }
    }
  }

  return { recherches, sources: [...parUrl.entries()].map(([url, title]) => ({ url, title })) };
}

/** `status` + `incomplete_details` → la raison d'arrêt NEUTRE. */
export function stopOfResponse(payload: RespPayload, hasCalls: boolean): ModelStop {
  if (hasCalls) return "tools"; // fait foi, comme sur l'autre porte
  switch (payload.status) {
    case "completed":
      return "end";
    case "incomplete":
      return payload.incomplete_details?.reason === "content_filter" ? "refusal" : "length";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return payload.status ? "end" : "error";
  }
}

// ─────────────────────────────── L'appel ───────────────────────────────

export function urlDe(): string {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  return `${base}/v1/responses`;
}

export function sansCle(binding: ModelBinding): ModelReply {
  return {
    ok: false,
    configured: false,
    stop: "error",
    blocks: [],
    usage: emptyUsage(binding.role, binding.model, "openai"),
    error: "Clé OPENAI_API_KEY non configurée.",
  };
}
