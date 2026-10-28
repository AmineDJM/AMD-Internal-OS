/**
 * OPENAI GPT-5.6 LUNA — palier économique de l'analyseur CTD.
 *
 * Pourquoi ce modèle ici, au-delà du prix :
 *   • **multimodal** (texte + image) → on lui envoie les pages RASTÉRISÉES, ce que l'OCR
 *     réduisait à du texte. C'est ce qui permet enfin de lire une courbe de stabilité, un
 *     chromatogramme ou un schéma de procédé ;
 *   • **1 050 000 jetons de contexte** → beaucoup moins de découpage en parts, donc moins
 *     d'appels et moins de perte de contexte entre les parts ;
 *   • **sorties structurées par schéma JSON** → fini le « réponse IA non exploitable » ;
 *   • **0,20 $ / 1,20 $** par million de jetons, **×0,5 en Batch**.
 *
 * Claude reste le palier QUALITÉ (arbitrage des ambiguïtés, findings critiques, rédaction des
 * réponses aux réserves) : ce fichier ne le remplace pas, il travaille à côté.
 *
 * Serveur uniquement. Ne lève jamais : tout échec revient en résultat structuré.
 *
 * ── CE QUE CE SOUS-SYSTÈME DOIT À ADAM V2 (dette nommée, pas corrigée ici) ────────────────
 *
 * Ce fichier est le chemin CTD — vision de pages rastérisées, Batch 24 h, embeddings. Il est
 * INDÉPENDANT de la couche modèle d'Adam (`src/lib/models/`) et n'a pas été migré avec elle :
 * son objet n'est pas une boucle d'agent, et le Batch a ses propres contraintes de format.
 *
 * Trois écarts sont CONNUS et mesurés, pour qu'on ne les redécouvre pas par une panne :
 *
 *   1. Il parle `/v1/chat/completions` alors que Luna est un modèle de raisonnement. Cela
 *      fonctionne ici parce qu'il n'envoie AUCUN outil : c'est la combinaison « raisonnement
 *      + outils » que cette porte refuse, pas le raisonnement seul.
 *   2. Il pose `temperature`, que Luna refuse. Un rattrapage la retire et rejoue — donc un
 *      aller-retour perdu à chaque appel qui en pose une (`review-ai.ts`, `library-extract.ts`).
 *   3. Il utilise `response_format` et `max_completion_tokens`, les noms de l'ancienne porte.
 *
 * Adam, lui, ne peut plus rien émettre de tout cela : `src/lib/models/capabilities.ts` tient la
 * liste blanche par modèle et le constructeur n'assemble que ce qu'elle autorise. Le jour où ce
 * sous-système migrera, c'est ce registre qu'il devra interroger — pas une seconde table.
 */

import { sanitizeForModel } from "./ai-text";
import { mentionsUnsupportedTemperature, providerErrorMessage } from "./models/errors";
// L'interrupteur général de « Contrôle de l'IA » : lu AVANT tout envoi de données (voir `callLuna`).
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "./ai-settings";
import { attendu } from "@/lib/journal";

// Tarifs officiels (30 juillet 2026), en dollars par MILLION de jetons.
const PRICE_INPUT_PER_M = 0.2;
const PRICE_OUTPUT_PER_M = 1.2;
/** Le Batch (fenêtre 24 h) est facturé à moitié prix, en entrée comme en sortie. */
export const BATCH_MULTIPLIER = 0.5;

export const LUNA_MODEL = "gpt-5.6-luna";

export function lunaConfigured(): boolean {
  return Boolean((process.env.OPENAI_API_KEY ?? "").trim());
}

/** Modèle économique effectif (surchargeable sans toucher au code). */
export function lunaModel(): string {
  return (process.env.CTD_MODEL_CHEAP ?? "").trim() || LUNA_MODEL;
}

/**
 * Coût d'un appel, en dollars. Les jetons mis en cache sont facturés par OpenAI à un tarif
 * réduit, mais on reste **volontairement conservateur** : mieux vaut annoncer un coût
 * légèrement supérieur au réel que de faire exploser un budget qu'on croyait tenu.
 */
export function lunaCostUsd(inputTokens: number, outputTokens: number, batch = false): number {
  const m = batch ? BATCH_MULTIPLIER : 1;
  const usd = ((inputTokens / 1_000_000) * PRICE_INPUT_PER_M + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M) * m;
  return Math.round(usd * 1_000_000) / 1_000_000; // au millionième de dollar
}

/** Estimation de jetons quand l'API n'en renvoie pas (~4 caractères par jeton). */
export const estimateTokens = (text: string): number => Math.ceil((text ?? "").length / 4);

// ───────────────────────────── Appel unitaire ─────────────────────────────

export interface LunaImage {
  /** Données brutes de l'image (page rastérisée). */
  buffer: Buffer;
  mime?: string;
}

export interface LunaCallInput {
  system?: string;
  user: string;
  /** Pages rastérisées à faire LIRE au modèle (graphiques, schémas, tableaux scannés). */
  images?: LunaImage[];
  /** Schéma JSON attendu — la réponse est alors garantie conforme. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Forcer une réponse JSON VALIDE (response_format json_object) quand on n'a pas de schéma strict. */
  jsonObject?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  model?: string;
}

export interface LunaUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export interface LunaResult<T = unknown> {
  ok: boolean;
  configured: boolean;
  /** Texte brut de la réponse. */
  text: string;
  /** Objet analysé quand un schéma JSON a été demandé. */
  data?: T;
  usage: LunaUsage;
  error?: string;
}

const EMPTY_USAGE: LunaUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

interface ChatMessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

/** Construit le corps d'un appel Chat Completions (texte + images + schéma JSON). */
export function buildLunaBody(input: LunaCallInput, batch = false): Record<string, unknown> {
  // ASSAINISSEMENT au point de passage UNIQUE de l'appel synchrone ET du Batch : aucune voie ne
  // peut l'oublier. Un caractère invalide hérité de l'OCR faisait refuser la requête (400) et,
  // avec elle, la revue de fond du dossier entier.
  const user = sanitizeForModel(input.user);
  const system = input.system ? sanitizeForModel(input.system) : undefined;
  const content: ChatMessageContent[] = [{ type: "text", text: user }];
  for (const img of input.images ?? []) {
    const mime = img.mime ?? "image/png";
    content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${img.buffer.toString("base64")}` } });
  }

  const messages: { role: string; content: string | ChatMessageContent[] }[] = [];
  if (system) messages.push({ role: "system", content: system });
  // Une seule partie texte et pas d'image → forme simple (payload plus léger).
  messages.push({ role: "user", content: content.length === 1 ? user : content });

  return {
    model: input.model ?? lunaModel(),
    messages,
    max_completion_tokens: input.maxOutputTokens ?? 2000,
    // ⚠ DETTE CONNUE, MESURÉE, NON CORRIGÉE ICI — voir l'en-tête « Ce que ce sous-système doit
    // à Adam V2 ». Luna EST un modèle de raisonnement et refuse `temperature` ; le rattrapage
    // ligne ~231 le retire et rejoue, ce qui coûte UN ALLER-RETOUR PERDU par appel qui en pose
    // une. Le correctif est de ne pas la poser du tout, comme Adam le fait désormais.
    ...(input.temperature != null ? { temperature: input.temperature } : {}),
    ...(input.jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: input.jsonSchema.name, schema: input.jsonSchema.schema, strict: true },
          },
        }
      : input.jsonObject
        ? { response_format: { type: "json_object" } } // JSON garanti par l'API, pas par la bonne volonté du modèle
        : {}),
    ...(batch ? {} : { service_tier: "default" }),
  };
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Lit l'usage renvoyé par l'API et en déduit le coût. */
export function readUsage(raw: ChatResponse["usage"], fallbackIn: number, fallbackOut: number, batch = false): LunaUsage {
  const inputTokens = raw?.prompt_tokens ?? fallbackIn;
  const outputTokens = raw?.completion_tokens ?? fallbackOut;
  const cachedInputTokens = raw?.prompt_tokens_details?.cached_tokens ?? 0;
  return { inputTokens, outputTokens, cachedInputTokens, costUsd: lunaCostUsd(inputTokens, outputTokens, batch) };
}

/**
 * CES DEUX FONCTIONS ONT DÉMÉNAGÉ dans `src/lib/models/errors.ts`, qui est leur vraie place :
 * ce n'est pas une connaissance du module CTD, c'est une connaissance du FOURNISSEUR. Elles
 * restent exportées d'ici — les appelants et les tests de ce module n'ont pas à savoir qu'un
 * étage a été construit en dessous.
 */
export { mentionsUnsupportedTemperature } from "./models/errors";
export { providerErrorMessage as lunaErrorMessage } from "./models/errors";

/**
 * Appel synchrone. À réserver aux cas INTERACTIFS (l'utilisateur attend) ; pour l'analyse d'un
 * dossier entier, passer par le Batch — même travail, moitié prix.
 */
export async function callLuna<T = unknown>(input: LunaCallInput): Promise<LunaResult<T>> {
  // L'INTERRUPTEUR AVANT LA CLÉ (§118.196). Ce client ne passe pas par `lib/ai.ts` : l'intelligence
  // réglementaire (lecture visuelle, réserves, revue, corpus) appelait le modèle sous un interrupteur
  // coupé pendant que l'écran affichait « Toute l'IA est coupée ». Coupé : rien ne part, rien n'est
  // compté, et l'appelant reçoit l'échec qu'il traite déjà — `configured: true`, la clé n'est pas en cause.
  if (await interrupteurIaCoupe()) return { ok: false, configured: true, text: "", usage: EMPTY_USAGE, error: REFUS_IA_COUPEE };
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return { ok: false, configured: false, text: "", usage: EMPTY_USAGE, error: "Clé OPENAI_API_KEY non configurée." };

  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  const body = buildLunaBody(input);
  const approxIn = estimateTokens(`${input.system ?? ""}${input.user}`) + (input.images?.length ?? 0) * 800;

  // Jusqu'à 3 tentatives sur surcharge / limite de débit / réseau.
  let lastError = "Appel à l'IA impossible (réseau).";
  let droppedTemperature = false;
  let grewBudget = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });

      if (res.ok) {
        const data = (await res.json()) as ChatResponse;
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? "";

        // RÉPONSE VIDE — le piège des modèles de RAISONNEMENT : max_completion_tokens couvre AUSSI
        // la réflexion interne. Un budget calibré pour la seule réponse est englouti par le
        // raisonnement, et le contenu revient vide avec finish_reason=length. En aval cela
        // devenait « JSON invalide » pour le dossier ENTIER, sans que rien ne nomme la cause.
        // On rejoue UNE fois avec un budget triplé ; sinon, l'erreur dit exactement ce qui rentre.
        if (!text.trim()) {
          const fr = choice?.finish_reason ?? "inconnu";
          if (fr === "length" && !grewBudget) {
            grewBudget = true;
            const current = Number((body as { max_completion_tokens?: number }).max_completion_tokens ?? 2000);
            (body as { max_completion_tokens?: number }).max_completion_tokens = current * 3;
            console.warn(`[luna] réponse vide (finish_reason=length) — budget de sortie ${current} → ${current * 3}, nouvelle tentative`);
            continue;
          }
          lastError = `Réponse IA VIDE (finish_reason=${fr}${fr === "length" ? " — budget de sortie épuisé par le raisonnement interne du modèle" : ""}).`;
          return { ok: false, configured: true, text: "", usage: readUsage(data.usage, approxIn, 0), error: lastError };
        }
        const usage = readUsage(data.usage, approxIn, estimateTokens(text));
        let parsed: T | undefined;
        if (input.jsonSchema && text) {
          try { parsed = JSON.parse(text) as T; } catch { /* le schéma strict rend ce cas très rare */ }
        }
        return { ok: true, configured: true, text, data: parsed, usage };
      }

      const raw = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[luna] erreur API", res.status, raw.slice(0, 300));
      lastError = providerErrorMessage(res.status, raw);

      // PARAMÈTRE REFUSÉ PAR LE MODÈLE → on le retire et on rejoue, une fois.
      //
      // Les modèles de raisonnement récents n'acceptent plus `temperature` : ils répondent 400
      // « Unsupported value », de façon DÉTERMINISTE. Envoyé à chaque part, ce paramètre faisait
      // donc échouer la revue de fond du dossier ENTIER — pas une part de temps en temps, TOUT,
      // à chaque tentative. Or la température n'est pas essentielle ici : les garde-fous en aval
      // (schéma de sortie, ancrage des preuves) ne dépendent pas d'elle. On la retire et on
      // continue, plutôt que de rendre un dossier non analysé.
      if (res.status === 400 && !droppedTemperature && mentionsUnsupportedTemperature(raw)) {
        droppedTemperature = true;
        delete (body as { temperature?: number }).temperature;
        console.warn("[luna] `temperature` refusée par le modèle — retirée, nouvelle tentative");
        continue;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 3) return { ok: false, configured: true, text: "", usage: EMPTY_USAGE, error: lastError };
    } catch (err) {
      console.error(`[luna] appel échoué (tentative ${attempt})`, err);
      lastError = "Appel à l'IA impossible (réseau ou délai dépassé).";
      if (attempt === 3) return { ok: false, configured: true, text: "", usage: EMPTY_USAGE, error: lastError };
    }
    await new Promise((r) => setTimeout(r, 700 * attempt));
  }
  return { ok: false, configured: true, text: "", usage: EMPTY_USAGE, error: lastError };
}

// ───────────────────────────── Batch (moitié prix) ─────────────────────────────

export interface BatchRequest {
  /** Identifiant que l'on retrouvera dans le résultat (ex. `documentId:section`). */
  customId: string;
  input: LunaCallInput;
}

/**
 * Une ligne du fichier JSONL attendu par l'API Batch. Fonction PURE : c'est elle qui est
 * testée, sans réseau.
 */
export function buildBatchLine(req: BatchRequest): string {
  return JSON.stringify({
    custom_id: req.customId,
    method: "POST",
    url: "/v1/chat/completions",
    body: buildLunaBody(req.input, true),
  });
}

export function buildBatchJsonl(requests: BatchRequest[]): string {
  return requests.map(buildBatchLine).join("\n");
}

export interface BatchSubmitResult {
  ok: boolean;
  batchId?: string;
  error?: string;
}

/**
 * Dépose un lot et renvoie son identifiant. Le lot est traité sous 24 h à **moitié prix** —
 * c'est le mode normal d'analyse d'un dossier, qui n'a aucune raison d'être synchrone.
 */
export async function submitBatch(requests: BatchRequest[]): Promise<BatchSubmitResult> {
  // Un lot dépose les documents chez le fournisseur : l'interrupteur d'abord. Lire l'état d'un lot
  // déjà déposé (`getBatchStatus`) et rapatrier sa sortie (`fetchBatchOutput`) restent ouverts,
  // exprès : rien n'y part, et couper la lecture ferait perdre un travail déjà payé.
  if (await interrupteurIaCoupe()) return { ok: false, error: REFUS_IA_COUPEE };
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return { ok: false, error: "Clé OPENAI_API_KEY non configurée." };
  if (requests.length === 0) return { ok: false, error: "Lot vide." };

  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  try {
    // 1) Téléverser le JSONL.
    const form = new FormData();
    form.set("purpose", "batch");
    form.set("file", new Blob([buildBatchJsonl(requests)], { type: "application/jsonl" }), "batch.jsonl");
    const up = await fetch(`${base}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!up.ok) return { ok: false, error: `Dépôt du lot refusé (HTTP ${up.status}).` };
    const file = (await up.json()) as { id?: string };
    if (!file.id) return { ok: false, error: "Dépôt du lot : identifiant de fichier manquant." };

    // 2) Créer le lot.
    const created = await fetch(`${base}/v1/batches`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ input_file_id: file.id, endpoint: "/v1/chat/completions", completion_window: "24h" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!created.ok) return { ok: false, error: `Création du lot refusée (HTTP ${created.status}).` };
    const batch = (await created.json()) as { id?: string };
    return batch.id ? { ok: true, batchId: batch.id } : { ok: false, error: "Création du lot : identifiant manquant." };
  } catch (err) {
    console.error("[luna] dépôt de lot impossible", err);
    return { ok: false, error: "Dépôt du lot impossible (réseau)." };
  }
}

export interface BatchOutcome {
  customId: string;
  ok: boolean;
  text: string;
  usage: LunaUsage;
  error?: string;
}

/** Analyse le JSONL de résultats d'un lot. Fonction PURE — testée sans réseau. */
export function parseBatchOutput(jsonl: string): BatchOutcome[] {
  const out: BatchOutcome[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as {
        custom_id?: string;
        response?: { status_code?: number; body?: ChatResponse };
        error?: { message?: string } | null;
      };
      const customId = row.custom_id ?? "";
      if (row.error) {
        out.push({ customId, ok: false, text: "", usage: EMPTY_USAGE, error: row.error.message ?? "Requête refusée par le service, sans motif." });
        continue;
      }
      const body = row.response?.body;
      const text = body?.choices?.[0]?.message?.content ?? "";
      const okStatus = (row.response?.status_code ?? 200) < 400;
      out.push({
        customId, ok: okStatus && Boolean(text), text,
        usage: readUsage(body?.usage, 0, estimateTokens(text), true),
        ...(okStatus ? {} : { error: `HTTP ${row.response?.status_code}` }),
      });
    } catch {
      // Une ligne illisible ne doit pas faire perdre tout le lot.
    }
  }
  return out;
}

export interface BatchStatus {
  ok: boolean;
  status?: string; // validating | in_progress | finalizing | completed | failed | expired | cancelled
  outputFileId?: string | null;
  counts?: { total: number; completed: number; failed: number };
  error?: string;
}

export async function getBatchStatus(batchId: string): Promise<BatchStatus> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return { ok: false, error: "Clé OPENAI_API_KEY non configurée." };
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v1/batches/${batchId}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { ok: false, error: `Lecture du lot refusée (HTTP ${res.status}).` };
    const b = (await res.json()) as {
      status?: string; output_file_id?: string | null;
      request_counts?: { total?: number; completed?: number; failed?: number };
    };
    return {
      ok: true,
      status: b.status,
      outputFileId: b.output_file_id ?? null,
      counts: { total: b.request_counts?.total ?? 0, completed: b.request_counts?.completed ?? 0, failed: b.request_counts?.failed ?? 0 },
    };
  } catch (err) {
    console.error("[luna] lecture de lot impossible", err);
    return { ok: false, error: "Lecture du lot impossible (réseau)." };
  }
}

/** Récupère le JSONL de résultats d'un lot terminé. */
export async function fetchBatchOutput(outputFileId: string): Promise<string | null> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return null;
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v1/files/${outputFileId}/content`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(180_000),
    });
    return res.ok ? await res.text() : null;
  } catch (err) {
    console.error("[luna] récupération des résultats impossible", err);
    return null;
  }
}

// ───────────────────────────── Embeddings (recherche sémantique) ─────────────────────────────

/** Modèle d'embedding (surchargable). 512 dimensions suffisent et divisent le stockage par trois. */
export function lunaEmbedModel(): string {
  return (process.env.CTD_EMBED_MODEL ?? "").trim() || "text-embedding-3-small";
}
export const EMBED_DIMS = 512;

/**
 * Vectorise des textes pour la recherche SÉMANTIQUE — celle qui comprend qu'une « durée de
 * conservation » et une « shelf life » parlent de la même chose. C'est le chaînon qui manquait
 * au RAG : le corpus est largement en ANGLAIS (ICH, EMA) et les dossiers en FRANÇAIS — une
 * recherche lexicale ne les fera jamais se rencontrer.
 *
 * Ne lève jamais : sans clé ou en cas d'échec, `null` — l'appelant reste en lexical pur.
 */
export async function lunaEmbed(texts: string[], dims: number = EMBED_DIMS): Promise<number[][] | null> {
  if (!lunaConfigured() || texts.length === 0) return null;
  // Vectoriser, c'est ENVOYER les textes : sous l'interrupteur, `null` — l'appelant reste en lexical pur.
  if (await interrupteurIaCoupe()) return null;
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: lunaEmbedModel(), input: texts.map((t) => t.slice(0, 6000)), dimensions: dims }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(json.data) || json.data.length !== texts.length) return null;
    const out: number[][] = new Array(texts.length);
    for (const d of json.data) out[d.index] = d.embedding;
    return out;
  } catch {
    return null;
  }
}
