import type { OcrResult, OcrPage } from "./ocr-engine";
import { openPdf, type PdfSource } from "./pdf-split";
import { attendu } from "@/lib/journal";

/**
 * MOTEUR OCR CLOUD — Mistral OCR (`mistral-ocr-latest`).
 *
 * Moteur PRIMAIRE quand `MISTRAL_API_KEY` est présent : un SEUL appel réseau par document
 * (multi-pages géré côté serveur Mistral), très rapide et précis. Repli automatique sur
 * Tesseract (auto-hébergé) géré dans `ocr-engine.ts` si la clé est absente ou en cas d'échec.
 *
 * ⚠️ Service TIERS PAYANT (facturé À LA PAGE) nécessitant un réseau sortant. Aucune donnée
 * simulée : sans clé, on n'appelle pas Mistral et on retombe sur l'OCR local.
 *
 * Mistral ne renvoie PAS de score de confiance par page. On présume donc une confiance haute
 * (95) sur toute page contenant du texte, et 0 (→ REVUE HUMAINE) sur une page vide/illisible.
 */

const DEFAULT_URL = "https://api.mistral.ai/v1/ocr";
const DEFAULT_MODEL = "mistral-ocr-latest";
const MISTRAL_CONFIDENCE = 95; // confiance présumée d'une page non vide (Mistral ne score pas)

/** Extensions supportées par Mistral OCR → type MIME du data-URL envoyé. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  gif: "image/gif",
};

/** Vrai si une clé Mistral OCR est configurée (moteur primaire activable). */
export function mistralOcrConfigured(): boolean {
  return Boolean((process.env.MISTRAL_API_KEY ?? "").trim());
}

/**
 * Vrai si le document PEUT être traité par Mistral OCR. Un PDF est TOUJOURS éligible, même
 * volumineux : on le DÉCOUPE en tranches de pages sous les limites du service (voir mistralOcrDocument).
 * Une image (non découpable) reste bornée à la taille max — au-delà, OCR local (Tesseract sait réduire).
 */
export function mistralOcrEligible(ext: string, buffer: Buffer): boolean {
  const e = ext.toLowerCase();
  if (!MIME_BY_EXT[e]) return false;
  if (e === "pdf") return true; // découpable → aucune limite de taille bloquante
  return buffer.length <= maxBytes();
}

function ocrUrl(): string {
  return (process.env.REG_MISTRAL_OCR_URL ?? "").trim() || DEFAULT_URL;
}
function ocrModel(): string {
  return (process.env.REG_MISTRAL_OCR_MODEL ?? "").trim() || DEFAULT_MODEL;
}
function maxAttempts(): number {
  const n = Number(process.env.REG_MISTRAL_OCR_ATTEMPTS ?? 4);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}
function timeoutMs(): number {
  const n = Number(process.env.REG_MISTRAL_OCR_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}
function backoffMs(attempt: number): number {
  const base = Number(process.env.REG_MISTRAL_OCR_BACKOFF_MS ?? 500);
  const b = Number.isFinite(base) && base >= 0 ? base : 500;
  return Math.min(b * 2 ** (attempt - 1), 8000);
}
function defaultMaxPages(): number {
  const n = Number(process.env.REG_MISTRAL_OCR_MAX_PAGES ?? 1000);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1000;
}
/** Plafond de taille par document (Mistral OCR ≈ 50 Mo max) — marge de sécurité par défaut à 48 Mo. */
function maxBytes(): number {
  const mb = Number(process.env.REG_MISTRAL_OCR_MAX_MB ?? 48);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : 48) * 1024 * 1024);
}
function lowConfidenceThreshold(): number {
  const n = Number(process.env.REG_OCR_MIN_CONFIDENCE ?? 62);
  return Number.isFinite(n) ? n : 62;
}
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}
/** Pages par tranche pour le découpage d'un PDF (unité par défaut : 10 pages, comme la revue IA). */
function chunkPageSize(): number {
  return clampInt(process.env.REG_OCR_CHUNK_PAGES, 10, 1, 1000);
}
/** Tranches océrisées EN PARALLÈLE au sein d'UN document (borne le pic mémoire des sous-PDF). */
function chunkConcurrency(): number {
  return clampInt(process.env.REG_OCR_CHUNK_CONCURRENCY, 4, 1, 16);
}

/** Pool à concurrence bornée. `fn` peut lever : l'erreur est propagée (le caller décide). */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Convertit la réponse brute de l'API Mistral OCR en `OcrResult` (même contrat que Tesseract).
 * Exporté pour test unitaire (sans réseau). Ne dépend d'aucun état global hors variables d'env.
 */
export function parseMistralOcr(json: unknown, opts: { langs: string; maxPages: number; model: string }): OcrResult {
  const data = (json ?? {}) as {
    pages?: Array<{ index?: number; markdown?: string; text?: string }>;
    usage_info?: { pages_processed?: number };
  };
  const rawPages = Array.isArray(data.pages) ? data.pages : [];
  const processed = data.usage_info?.pages_processed ?? rawPages.length;
  const capped = rawPages.slice(0, Math.max(1, opts.maxPages));
  const truncated = rawPages.length > capped.length || processed > capped.length;
  const low = lowConfidenceThreshold();

  const pages: OcrPage[] = capped.map((p, i) => {
    const text = (p.markdown ?? p.text ?? "").trim();
    const hasText = text.length > 0;
    const confidence = hasText ? MISTRAL_CONFIDENCE : 0;
    return {
      page: typeof p.index === "number" && p.index >= 0 ? p.index + 1 : i + 1,
      text,
      confidence,
      chars: text.length,
      lowConfidence: confidence < low, // page vide → revue humaine
    };
  });

  const text = pages.map((p) => p.text).join("\n\n").trim();
  const withText = pages.filter((p) => p.chars > 0);
  const meanConfidence = withText.length > 0 ? Math.round(withText.reduce((s, p) => s + p.confidence, 0) / withText.length) : 0;
  const lowConfidencePages = pages.filter((p) => p.lowConfidence).length;

  return {
    engine: `mistral/${opts.model}`,
    langs: opts.langs,
    method: "ocr",
    pages,
    text,
    meanConfidence,
    pageCount: processed > 0 ? processed : pages.length,
    lowConfidencePages,
    needsReview: meanConfidence < low || lowConfidencePages > 0 || text.length === 0,
    truncated,
  };
}

/** POST vers l'API Mistral OCR avec réessais bornés (429/5xx/réseau) et délai d'attente. */
async function postOcr(apiKey: string, body: string): Promise<unknown> {
  const attempts = maxAttempts();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const res = await fetch(ocrUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()) as unknown;
      const detail = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      const err = new Error(`Mistral OCR ${res.status} : ${detail.slice(0, 300)}`);
      // 4xx (hors 429) = erreur de requête → échec immédiat, inutile de réessayer.
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err; // 429 / 5xx → transitoire, on réessaie
    } catch (err) {
      // Erreur HTTP 4xx déjà formatée → propager sans réessai ; le reste (réseau/timeout/429/5xx) → réessai.
      if (err instanceof Error && /^Mistral OCR 4\d\d/.test(err.message) && !/^Mistral OCR 429/.test(err.message)) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(backoffMs(attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error("Mistral OCR : échec après plusieurs tentatives.");
}

/** UN appel Mistral OCR pour UN buffer (PDF ou image). Sous les limites du service. */
async function mistralOcrOnce(apiKey: string, ext: string, buffer: Buffer, opts: { langs: string; maxPages: number; model: string }): Promise<OcrResult> {
  const mime = MIME_BY_EXT[ext];
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  // PDF → document_url ; image → image_url (le data-URL embarque le contenu, aucun upload séparé).
  const document = ext === "pdf" ? { type: "document_url", document_url: dataUrl } : { type: "image_url", image_url: dataUrl };
  const body = JSON.stringify({ model: opts.model, document, include_image_base64: false });
  const json = await postOcr(apiKey, body);
  return parseMistralOcr(json, opts);
}

/** Concatène des résultats de tranches EN ORDRE en renumérotant les pages 1..N (numéro absolu). */
function mergeChunkResults(parts: OcrResult[], opts: { langs: string; model: string; totalPages: number }): OcrResult {
  const pages: OcrPage[] = [];
  for (const part of parts) for (const p of part.pages) pages.push({ ...p, page: pages.length + 1 });
  const text = pages.map((p) => p.text).join("\n\n").trim();
  const withText = pages.filter((p) => p.chars > 0);
  const meanConfidence = withText.length > 0 ? Math.round(withText.reduce((s, p) => s + p.confidence, 0) / withText.length) : 0;
  const lowConfidencePages = pages.filter((p) => p.lowConfidence).length;
  const low = lowConfidenceThreshold();
  return {
    engine: `mistral/${opts.model}`, langs: opts.langs, method: "ocr", pages, text,
    meanConfidence, pageCount: opts.totalPages, lowConfidencePages,
    needsReview: meanConfidence < low || lowConfidencePages > 0 || text.length === 0,
    truncated: parts.some((p) => p.truncated),
  };
}

/** Tranche de pages illisibles → pages VIDES signalées revue humaine (jamais présumées correctes). */
function blankPages(count: number): OcrResult {
  const pages: OcrPage[] = Array.from({ length: Math.max(1, count) }, (_, i) => ({ page: i + 1, text: "", confidence: 0, chars: 0, lowConfidence: true }));
  return { engine: "mistral", langs: "auto", method: "ocr", pages, text: "", meanConfidence: 0, pageCount: count, lowConfidencePages: pages.length, needsReview: true, truncated: false };
}

/**
 * Océrise la plage [start, count) d'un gros PDF. Sérialise la tranche ; si le sous-PDF dépasse
 * la limite de taille, la plage est RE-COUPÉE en deux (adaptatif) jusqu'à passer. Renvoie les
 * pages de la plage (numérotées localement — renumérotées globalement à la fusion).
 */
async function ocrRange(apiKey: string, src: PdfSource, start: number, count: number, opts: { langs: string; model: string }): Promise<OcrResult> {
  const buf = src.extractRange(start, count);
  if (buf.length > maxBytes() && count > 1) {
    const half = Math.floor(count / 2);
    const a = await ocrRange(apiKey, src, start, half, opts);
    const b = await ocrRange(apiKey, src, start + half, count - half, opts);
    return mergeChunkResults([a, b], { ...opts, totalPages: count });
  }
  return mistralOcrOnce(apiKey, "pdf", buf, { langs: opts.langs, maxPages: count, model: opts.model });
}

/**
 * Découpe un gros PDF en tranches de pages océrisées EN PARALLÈLE, puis fusionne dans l'ordre.
 * Robuste : une tranche qui échoue après réessais → pages vides (revue humaine), les autres
 * passent. Si TOUTES échouent (clé/réseau HS) → on lève (le mode auto bascule alors sur Tesseract).
 */
async function ocrLargePdf(apiKey: string, src: PdfSource, opts: { langs: string; model: string }): Promise<OcrResult> {
  const size = chunkPageSize();
  const plan: Array<{ start: number; count: number }> = [];
  for (let s = 0; s < src.pageCount; s += size) plan.push({ start: s, count: Math.min(size, src.pageCount - s) });

  const results: OcrResult[] = new Array(plan.length);
  let ok = 0;
  let firstErr: unknown;
  await runPool(plan, chunkConcurrency(), async (range, i) => {
    try {
      results[i] = await ocrRange(apiKey, src, range.start, range.count, opts);
      ok++;
    } catch (err) {
      firstErr = firstErr ?? err;
      results[i] = blankPages(range.count); // tranche illisible → revue, on continue
      console.error(`[reg-ocr] tranche ${range.start + 1}-${range.start + range.count} échouée :`, err instanceof Error ? err.message : err);
    }
  });
  if (ok === 0) throw firstErr instanceof Error ? firstErr : new Error("Mistral OCR : toutes les tranches ont échoué.");
  return mergeChunkResults(results, { ...opts, totalPages: src.pageCount });
}

/**
 * Océrise UN document (PDF ou image) via Mistral OCR. Renvoie un `OcrResult` (contrat commun).
 * Un PDF au-delà d'une tranche (`REG_OCR_CHUNK_PAGES`, def. 400 pages) OU trop volumineux est
 * DÉCOUPÉ automatiquement (documents de 8 000–10 000 pages → dizaines de tranches parallèles,
 * fusionnées). Lève si clé absente, extension non supportée, ou API en échec (toutes tranches).
 */
export async function mistralOcrDocument(input: { ext: string; buffer: Buffer; langs?: string[]; maxPages?: number }): Promise<OcrResult> {
  const apiKey = (process.env.MISTRAL_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("MISTRAL_API_KEY absente — Mistral OCR indisponible.");
  const ext = input.ext.toLowerCase();
  if (!MIME_BY_EXT[ext]) throw new Error(`Mistral OCR non supporté pour « ${ext} ».`);

  const langs = input.langs && input.langs.length > 0 ? input.langs.join("+") : "auto";
  const model = ocrModel();

  if (ext === "pdf") {
    let src: PdfSource;
    try {
      src = await openPdf(input.buffer);
    } catch (err) {
      // PDF non ouvrable par mupdf (structure inhabituelle mais parfois acceptée par Mistral) :
      // on tente un appel unique direct s'il tient sous la limite de taille ; sinon on relaie l'erreur.
      console.warn("[reg-ocr] découpage PDF impossible → appel unique :", err instanceof Error ? err.message : err);
      if (input.buffer.length <= maxBytes()) return await mistralOcrOnce(apiKey, "pdf", input.buffer, { langs, maxPages: defaultMaxPages(), model });
      throw err instanceof Error ? err : new Error("PDF illisible et trop volumineux pour un appel unique.");
    }
    try {
      // Un seul appel si le PDF tient dans une tranche ET sous la limite de taille ; sinon découpage.
      if (src.pageCount <= chunkPageSize() && input.buffer.length <= maxBytes()) {
        return await mistralOcrOnce(apiKey, "pdf", input.buffer, { langs, maxPages: src.pageCount || defaultMaxPages(), model });
      }
      return await ocrLargePdf(apiKey, src, { langs, model });
    } finally {
      src.close();
    }
  }

  // Image : un seul appel (non découpable ; la garde d'éligibilité borne déjà la taille en amont).
  return mistralOcrOnce(apiKey, ext, input.buffer, { langs, maxPages: input.maxPages ?? defaultMaxPages(), model });
}

export interface MistralOcrDiag {
  engine: string;
  configured: boolean;
  ok: boolean;
  pagesProcessed?: number;
  sample?: string;
  error?: string;
}

/**
 * PING de diagnostic : génère une petite image et l'envoie à Mistral OCR pour PROUVER, en ligne,
 * que la clé et le réseau sortant fonctionnent AVANT un gros upload. Image raster simple (aucune
 * dépendance police/SVG) : le but est de valider clé + réseau + réponse, pas la reconnaissance.
 * Ne lève jamais — renvoie l'erreur classifiée le cas échéant.
 */
export async function mistralOcrSelfTest(): Promise<MistralOcrDiag> {
  const engine = `mistral/${ocrModel()}`;
  if (!mistralOcrConfigured()) return { engine, configured: false, ok: false, error: "MISTRAL_API_KEY absente." };
  try {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 320, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const r = await mistralOcrDocument({ ext: "png", buffer: png });
    return { engine, configured: true, ok: true, pagesProcessed: r.pageCount, sample: r.text.slice(0, 120) };
  } catch (err) {
    return { engine, configured: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
