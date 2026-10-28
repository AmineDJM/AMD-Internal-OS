import { sanitizeForModel } from "@/lib/ai-text";
import { providerErrorMessage, isRetryableStatus } from "./errors";
import { createHash } from "node:crypto";
import { capTools } from "./openai";
import { supportsParam, supportsWebSearch, type ParamName } from "./capabilities";
import { webSearchPricePerCall } from "./registry";
import { noterEnTetes, noter429, noterSucces } from "./throttle";
import { outputBudget, budgetDeSecours, BUDGET_POLICY } from "./budget";
import {
  type ModelBinding,
  type ModelBlock,
  type ModelCallOptions,
  type ModelReply,
  type ModelStop,
  type ModelTurn,
  costOf,
  emptyUsage,
} from "./contract";
import { attendu } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR RESPONSES — la porte par laquelle Terra et Luna parlent désormais.
 *
 * ── CE QUI CHANGE VRAIMENT PAR RAPPORT À CHAT COMPLETIONS ────────────────────────────────
 *
 * Changer l'URL n'aurait rien réglé : les deux API ne décrivent pas la même chose.
 *
 *   `messages`             → `input`, une SUITE D'ÉLÉMENTS et non une suite de messages. Un appel
 *                            d'outil et son résultat sont des éléments à part entière, plus des
 *                            messages déguisés (`role: "tool"`) portant un identifiant en douce.
 *   `system`               → `instructions`, au sommet de la requête.
 *   `tools[].function.*`   → `tools[].*` — la fonction n'est plus emboîtée d'un cran.
 *   `reasoning_effort: x`  → `reasoning: { effort: x }`.
 *   `max_completion_tokens`→ `max_output_tokens`.
 *   `choices[0].message`   → `output[]`, un TABLEAU d'éléments hétérogènes : du raisonnement, un
 *                            message, et zéro à N appels d'outils, chacun avec son `call_id`.
 *   `finish_reason`        → `status` + `incomplete_details.reason`.
 *
 * Le dernier point est celui qui compte pour la boucle d'agent : `output` porte NATURELLEMENT
 * plusieurs appels d'outils. Ils remontent tels quels, et la boucle les exécute déjà de front
 * (`Promise.all` dans `assistant.ts`) — la parallélisation ne demandait pas de code neuf, elle
 * demandait de ne pas perdre les appels en route.
 *
 * ── LE CHAÎNAGE `previous_response_id`, ET POURQUOI IL EST FERMÉ PAR DÉFAUT ──────────────
 *
 * Responses sait reprendre une réponse précédente par son identifiant — à condition qu'OpenAI
 * l'ait CONSERVÉE (`store: true`). C'est un vrai gain de jetons, et c'est aussi de la donnée
 * d'entreprise qui reste chez un tiers.
 *
 * Le défaut est donc `store: false` : on n'entrepose rien sans qu'on l'ait demandé. Le chaînage
 * s'active appel par appel (`previousResponseId`), et n'active la conservation que pour les
 * appels concernés. L'inverse — tout conserver au cas où — aurait marché aussi, et aurait fait
 * sortir l'historique complet de l'ERP sans que personne ait eu à le décider.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── Les formes du fournisseur ───────────────────────────────

interface RespFunctionCall {
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
interface RespWebSearchCall {
  type: "web_search_call";
  id?: string;
  status?: string;
}

type RespOutputItem = RespFunctionCall | RespMessage | RespReasoning | RespWebSearchCall | { type: string };

interface RespUsage {
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

interface RespPayload {
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
function parseArgs(raw: string | undefined): Record<string, unknown> {
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

function urlDe(): string {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  return `${base}/v1/responses`;
}

function sansCle(binding: ModelBinding): ModelReply {
  return {
    ok: false,
    configured: false,
    stop: "error",
    blocks: [],
    usage: emptyUsage(binding.role, binding.model, "openai"),
    error: "Clé OPENAI_API_KEY non configurée.",
  };
}

/**
 * L'USAGE D'UN APPEL — avec, désormais, DE QUOI JUGER LE BUDGET.
 *
 * Quatre nombres voyagent ensemble et n'ont de sens qu'ensemble : le plafond qu'on a fixé, ce qui
 * en a été consommé, la part partie en réflexion, et la raison d'un arrêt prématuré. Isolés, ils
 * ne répondent à rien ; réunis, ils répondent à la seule question qui compte ici — « la réserve de
 * raisonnement est-elle bien calibrée ? » — sans qu'on ait à la deviner.
 */
function usageDe(
  binding: ModelBinding,
  u: RespUsage | undefined,
  started: number,
  attempts: number,
  contexte: { maxOutputTokens?: number | null; incompleteReason?: string | null; webSearchCalls?: number } = {},
): ModelReply["usage"] {
  const inputTokens = u?.input_tokens ?? 0;
  const outputTokens = u?.output_tokens ?? 0;
  const enCache = u?.input_tokens_details?.cached_tokens ?? 0;
  const recherches = contexte.webSearchCalls ?? 0;

  // LE COÛT COMPLET : jetons (part en cache au tarif réduit quand il est renseigné) + recherches.
  // La règle « un tarif manquant rend le total inconnu » tient : si le tarif des jetons manque,
  // ajouter les recherches fabriquerait un total partiel avec l'air d'un total — on rend `null`.
  const coutJetons = costOf(binding, inputTokens, outputTokens, enCache);
  const costUsd = coutJetons == null
    ? null
    : Math.round((coutJetons + recherches * webSearchPricePerCall()) * 1_000_000) / 1_000_000;

  return {
    role: binding.role,
    model: binding.model,
    provider: "openai",
    inputTokens,
    outputTokens,
    cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    ...(recherches > 0 ? { webSearchCalls: recherches } : {}),
    maxOutputTokens: contexte.maxOutputTokens ?? null,
    incompleteReason: contexte.incompleteReason ?? null,
    costUsd,
    ms: Date.now() - started,
    attempts,
  };
}

/**
 * LA LIGNE DE JOURNAL DU BUDGET. Expurgée par construction : elle ne porte QUE des nombres — pas
 * un mot de la question, pas un mot de la réponse. C'est ce qui permet de la laisser allumée en
 * production sans faire fuir le contenu d'un dossier réglementaire dans les journaux.
 */
function journaliserBudget(
  binding: ModelBinding,
  plafond: number | null,
  u: RespUsage | undefined,
  payload: Pick<RespPayload, "status" | "incomplete_details">,
): void {
  const sortie = u?.output_tokens ?? 0;
  const raisonnement = u?.output_tokens_details?.reasoning_tokens ?? 0;
  const ligne = {
    role: binding.role,
    model: binding.model,
    max_output_tokens: plafond,
    output_tokens: sortie,
    reasoning_tokens: raisonnement,
    // La part effectivement lisible — le reste a servi à penser.
    visible_tokens: Math.max(0, sortie - raisonnement),
    status: payload.status ?? null,
    incomplete_details: payload.incomplete_details?.reason ?? null,
  };

  if (budgetEpuise(payload)) {
    // PAS un `info`. Un plafond atteint est une erreur de NOTRE réglage, payée au prix fort ; la
    // noyer dans le journal courant reviendrait à ne jamais la corriger.
    console.warn(`[models] BUDGET DE SORTIE ÉPUISÉ — ${JSON.stringify(ligne)}`);
    return;
  }
  if (process.env.ADAM_MODEL_DEBUG === "1") console.info("[models] budget", JSON.stringify(ligne));
}

/**
 * UN APPEL. Ne lève jamais — même règle que l'autre adaptateur : une exception qui traverse une
 * boucle d'agent perd l'usage déjà consommé, donc le coût déjà payé.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE RÉPONSE QUI MET TROP LONGTEMPS À COMMENCER EST PERDUE — et la rejouer la reperd.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Le banc de la chaîne humaine ne démarrait pas : chaque `mission.plan` rendait
 * « 502 upstream request failed », trois fois de suite, et la mission naissait sans étape.
 * La mesure a écarté les causes plausibles une à une :
 *
 *   • le modèle est sain      — 10 petits appels : 10 × 200 ;
 *   • la taille n'est pas en cause — 45 Ko, 226 Ko, 566 Ko, 1,3 Mo : 200 à chaque fois ;
 *   • une génération LONGUE, elle, tombe — 502 à 30 s EXACTEMENT, trois fois sur trois ;
 *   • la MÊME requête en flux passe — 200 en 39 s et 46 s, 3 000+ événements.
 *
 * Ce n'est donc pas le fournisseur : c'est un intermédiaire qui ferme une connexion restée
 * muette ~30 s. Un proxy d'entreprise, un répartiteur de charge, une passerelle d'hébergeur :
 * tous en ont un, et le nôtre n'est pas le seul chemin où Adam tournera.
 *
 * ── LA RÈGLE, ET POURQUOI ELLE N'EST PAS UN CONTOURNEMENT ───────────────────────────────
 *
 * Le recours est NOMMÉ PAR SA CAUSE : 502/504/522/524 sont des coupures d'intermédiaire, jamais
 * des refus du modèle. On rejoue alors EN FLUX — les octets partent tout de suite, aucun silence
 * ne s'installe, aucun intermédiaire n'a de raison de couper. Rejouer à l'identique, lui,
 * reperdrait à l'identique.
 *
 * ── POURQUOI LE FLUX N'EST PAS LE CHEMIN PAR DÉFAUT ─────────────────────────────────────
 *
 * Parce qu'il coûterait une protection. Le chemin simple porte la boucle de réessai ET le
 * rattrapage de budget (`budgetEpuise` → plafond élargi → rejeu), que le flux n'a pas. Router
 * tout le raisonnement vers le flux « au cas où » supprimerait ce filet en silence — le genre
 * d'échange qu'on ne remarque qu'en production. Le flux reste donc le RECOURS, pas la règle.
 *
 * ── ET LA SECONDE COUPURE NE SE PAIE PAS ────────────────────────────────────────────────
 *
 * Payer 30 s de silence avant chaque reprise reviendrait à redécouvrir la même chose à chaque
 * appel. Le modèle qui vient d'être coupé est donc NOTÉ, et les appels suivants partent
 * directement en flux pendant quelques minutes. C'est une MESURE du chemin réseau, pas une
 * hypothèse : là où aucun intermédiaire ne coupe (une production sans proxy bavard), rien n'est
 * jamais noté et rien ne change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const COUPURE_INTERMEDIAIRE = new Set([502, 504, 522, 524]);

/** Le modèle coupé récemment → on part en flux sans repayer le silence. Effacé par le temps. */
const COUPES = new Map<string, number>();
const MEMOIRE_COUPURE_MS = 10 * 60 * 1000;

const cheminCoupeRecemment = (model: string): boolean => {
  const t = COUPES.get(model);
  if (t === undefined) return false;
  if (Date.now() - t > MEMOIRE_COUPURE_MS) { COUPES.delete(model); return false; }
  return true;
};

/** Le flux employé comme TRANSPORT : personne ne lit les fragments, seul le résultat compte. */
const viaFlux = (binding: ModelBinding, turns: ModelTurn[], opts: ModelCallOptions): Promise<ModelReply> =>
  streamOpenAiResponses(binding, turns, opts, () => {});

/** Pour les tests : oublier ce qui a été mesuré du chemin réseau. */
export function oublierCoupures(): void {
  COUPES.clear();
}

export async function callOpenAiResponses(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions = {},
): Promise<ModelReply> {
  const started = Date.now();
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return sansCle(binding);

  // Ce chemin a DÉJÀ coupé sur ce modèle : inutile de repayer le silence pour le redécouvrir.
  if (cheminCoupeRecemment(binding.model)) return viaFlux(binding, turns, opts);

  const body = buildResponsesBody(binding, turns, opts);

  let lastError = "Appel au modèle impossible (réseau).";
  let grewBudget = false;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(urlDe(), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });

      // LA PORTE ÉCOUTE (§60) : les soldes annoncés nourrissent la concurrence adaptative, et un
      // 429 la divise en respectant `Retry-After`. C'est ici que les faits arrivent — l'adaptateur
      // les transmet, la porte décide.
      noterEnTetes(res.headers);
      if (res.status === 429) noter429(res.headers.get("retry-after"), res.headers.get("x-ratelimit-reset-requests"));

      if (res.ok) {
        noterSucces();
        const data = (await res.json()) as RespPayload;
        const blocks = fromResponsesOutput(data.output);
        const web = lireRecherchesWeb(data.output);
        const plafond = Number(body.max_output_tokens ?? 0) || null;

        // LES QUATRE NOMBRES, à chaque appel — c'est ce qui rend la politique de budget
        // corrigeable sur des faits plutôt que sur une impression.
        journaliserBudget(binding, plafond, data.usage, data);

        // LE RATTRAPAGE, restreint à la SEULE cause qu'il sait traiter.
        //
        // Il rejouait auparavant toute réponse vide et incomplète — y compris un `content_filter`,
        // où agrandir le budget ne peut rien changer et fait juste payer l'appel deux fois. Il ne
        // se déclenche donc plus que sur `max_output_tokens`, et son déclenchement est désormais
        // une ANOMALIE : la passerelle a calculé un budget exprès, s'il ne suffit pas c'est la
        // politique qui est fausse. Le journal le dit dans ces termes.
        //
        // ET IL COUVRE AUSSI LA RÉPONSE TRONQUÉE, pas seulement la vide. Le Run 4 a montré le
        // trou : 1 626 jetons visibles rendus AVANT le plafond → `blocks` non vide → aucun
        // rattrapage → la synthèse coupée en plein vol descendait la chaîne, tuait l'étape, et
        // la mission mourait BLOCKED. Agir sur une réponse tronquée est pire qu'un appel payé
        // deux fois — même règle que pour la réponse vide, borné à UNE relance (`grewBudget`).
        if (budgetEpuise(data) && !grewBudget) {
          grewBudget = true;
          const courant = Number(body.max_output_tokens ?? 0) || BUDGET_POLICY.RESERVE_RAISONNEMENT.medium;
          const relance = budgetDeSecours(courant);
          body.max_output_tokens = relance;
          console.warn(
            `[models] ${binding.role}/${binding.model} — le budget calculé n'a PAS suffi `
            + `(${courant} → ${relance}, raisonnement ${data.usage?.output_tokens_details?.reasoning_tokens ?? "?"} jetons). `
            + "La réserve de raisonnement de src/lib/models/budget.ts est à revoir : ce rattrapage "
            + "paie l'appel deux fois et ne doit pas devenir la normale.",
          );
          continue;
        }

        if (data.status === "failed") {
          return {
            ok: false,
            configured: true,
            stop: "error",
            blocks: [],
            usage: usageDe(binding, data.usage, started, attempt, {
              maxOutputTokens: plafond,
              incompleteReason: data.incomplete_details?.reason ?? null,
              // Les recherches d'un appel ÉCHOUÉ se paient quand même — elles se comptent.
              webSearchCalls: web.recherches,
            }),
            error: data.error?.message || "Le modèle a échoué sans message.",
          };
        }

        return {
          ok: true,
          configured: true,
          stop: stopOfResponse(data, blocks.some((b) => b.type === "tool_call")),
          blocks,
          usage: usageDe(binding, data.usage, started, attempt, {
            maxOutputTokens: plafond,
            // Renseigné SEULEMENT quand la réponse est réellement incomplète : mettre la raison
            // partout ferait passer un arrêt normal pour une coupure.
            incompleteReason: data.status === "incomplete" ? (data.incomplete_details?.reason ?? "incomplete") : null,
            webSearchCalls: web.recherches,
          }),
          ...(data.id ? { responseId: data.id } : {}),
          ...(web.sources.length ? { webSources: web.sources } : {}),
        };
      }

      const raw = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      lastError = providerErrorMessage(res.status, raw);

      // ── AUCUN RATTRAPAGE DE PARAMÈTRE ICI, ET C'EST LE POINT DE TOUT LE CHANTIER ────────
      //
      // Il y en avait deux : un pour `reasoning_effort`, un pour `temperature`. Chacun retirait
      // le champ fautif et rejouait. Chacun paraissait raisonnable seul ; ensemble, ils
      // formaient une méthode — envoyer au hasard, puis retirer ce qu'OpenAI refuse — et cette
      // méthode ne converge jamais. Elle produit un troisième 400, puis un quatrième.
      //
      // Désormais, un paramètre interdit n'est PAS construit (`buildResponsesBody` interroge
      // `capabilities.ts` champ par champ). Il n'y a donc plus rien à retirer.
      //
      // Si un 400 « unsupported parameter » revient malgré tout, c'est une VRAIE nouvelle :
      // OpenAI a changé sa contrainte, et il manque une ligne au registre. On veut le voir, pas
      // le contourner — d'où l'avertissement explicite plutôt qu'un `delete` silencieux.
      if (res.status === 400 && /unsupported parameter|not supported with this model/i.test(raw)) {
        console.error(
          `[models] CONTRAINTE FOURNISSEUR INCONNUE pour ${binding.model} : ${raw.slice(0, 200)}\n`
          + "  → il manque une entrée dans src/lib/models/capabilities.ts. "
          + "NE PAS corriger en retirant le champ à la volée : la contrainte doit être connue AVANT le réseau.",
        );
      }

      console.error("[models] openai responses error", binding.role, binding.model, res.status, raw.slice(0, 300));

      // LE RECOURS EST NOMMÉ PAR SA CAUSE. Une coupure d'intermédiaire ne se répare pas en
      // rejouant à l'identique — elle se répare en cessant de laisser la connexion muette.
      if (COUPURE_INTERMEDIAIRE.has(res.status)) {
        COUPES.set(binding.model, Date.now());
        console.warn(
          `[models] ${binding.role}/${binding.model} — HTTP ${res.status} après ${Date.now() - started} ms : `
          + "coupure d'intermédiaire, pas un refus du modèle. Reprise EN FLUX (le même appel, "
          + "des octets tout de suite).",
        );
        return viaFlux(binding, turns, opts);
      }
      if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) break;
    } catch (err) {
      if (opts.signal?.aborted) {
        lastError = "Appel interrompu.";
        break;
      }
      console.error(`[models] openai responses failed (${binding.role}, tentative ${attempt})`, err);
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
    usage: { ...emptyUsage(binding.role, binding.model, "openai"), ms: Date.now() - started },
    error: lastError,
  };
}

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
