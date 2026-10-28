import type { RegulatoryJob, RegJobType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { extractText } from "../extract/extract-text";
import { detectMime } from "@/lib/storage/mime";
import { classifyDocument } from "../ctd/classify";
import { detectContainedSections } from "../ctd/detect-sections";
import { assessVersion, type TwinDoc } from "../rules/engine";
import { loadActiveRules, loadPresentFactKeys } from "../rules/rule-engine";
import { missesArabic, arabicStats, isArabicRequiredSection } from "../rules/notice-arabic";
import { ocrDocument, canOcr } from "../ocr/ocr-engine";
import { mistralOcrConfigured } from "../ocr/mistral-ocr";
import { buildTwinFacts } from "../twin/build-facts";
import { detectConflicts } from "../twin/detect-conflicts";
import { reviewDocumentText, type AiFinding } from "../agents/review-agent";
import { runReviewerSimulation } from "../simulator/run";
import { lunaReviewFn } from "../agents/review-ai";
import { escalateCriticalSections } from "../agents/escalate";
import { corpusForSection } from "../corpus/for-section";
import { experienceForSection } from "../training/for-section";
import { readFigures, FORM_DEFECT_LABEL, FORM_DEFECT_SEVERITY } from "../vision/read-figures";
import { lunaConfigured } from "@/lib/openai-luna";
import { submitVersionReviewBatch } from "../cost/batch-runner";
import { splitTextIntoChunks, splitTextIntoChunksWithOffsets, chunkPageSpan } from "../agents/chunk-text";
import { pageSpanOfSlice, anchorEvidence } from "../extract/pages";
import { sectionByCode } from "../ctd/taxonomy";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { notifyRoles } from "@/lib/notify";
import { getAppSettings } from "@/lib/settings";
import { enrichVersionFindings, type EnrichmentContext } from "../findings/enrich";
import { regAudit } from "../audit";

/**
 * RUNNER de jobs Node-first (en base Postgres, sans Redis/BullMQ). Idempotent, verrou
 * optimiste, reprise après verrou expiré, réessais bornés. Déclenché par le planificateur
 * interne (runScheduledJobs) ; borné par tick (mémoire + latence maîtrisées).
 *
 * Phase 2 : handler EXTRACT (détection MIME + extraction texte, par lots). Les autres
 * types (CLASSIFY, RULES, AI_REVIEW…) arrivent aux phases suivantes ; un type sans handler
 * est marqué CANCELLED (jamais de boucle).
 */

const STALE_LOCK_MS = 5 * 60_000; // un job « RUNNING » figé > 5 min est repris
/**
 * Jobs pris par passage. Relevé de 5 à 20 : avec la séparation calcul / attente réseau, la
 * plupart des jobs d'un lot sont désormais des attentes qui se recouvrent. À 5, une quarantaine
 * de dossiers déposés ensemble s'écoulaient au compte-gouttes.
 */
const MAX_JOBS_PER_TICK = 20;
/**
 * Documents extraits par tour (le reste est re-mis en file, repris dans le MÊME passage depuis
 * l'introduction du budget de temps). Relevé de 20 à 40 : la mémoire ne dépend pas de ce nombre
 * — un seul document est chargé à la fois — seul le nombre d'allers-retours en base en dépend.
 */
const EXTRACT_BATCH = clampInt(process.env.REG_EXTRACT_BATCH, 40, 1, 200);
const OCR_BATCH_LOCAL = 3; // Tesseract = WASM/CPU lourd → petit lot séquentiel, reste re-mis en file

const ocrEnabled = () => (process.env.REG_OCR_ENABLED ?? "1") !== "0";

/**
 * Débit OCR adapté au moteur actif. Mistral (cloud) = latence RÉSEAU → on parallélise un gros
 * lot (plusieurs documents en vol) pour finir un dossier en quelques minutes. Tesseract (WASM
 * local, CPU/mémoire) reste SÉQUENTIEL (concurrence 1) sur un petit lot pour borner la RAM.
 */
function ocrIsCloud(): boolean {
  return (process.env.REG_OCR_ENGINE ?? "auto").trim().toLowerCase() !== "tesseract" && mistralOcrConfigured();
}
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function ocrBatchSize(): number {
  return ocrIsCloud() ? clampInt(process.env.REG_OCR_BATCH, 24, 1, 200) : OCR_BATCH_LOCAL;
}
// Concurrence AU NIVEAU DOCUMENT (défaut 3). Volontairement modérée : un document massif
// (8 000–10 000 pages) charge un gros blob + le découpe en mémoire, ET fait lui-même du parallélisme
// PAR TRANCHES en interne. Trop de gros documents en vol simultané = risque OOM. Ajustable selon la RAM.
function ocrConcurrency(): number {
  return ocrIsCloud() ? clampInt(process.env.REG_OCR_CONCURRENCY, 3, 1, 20) : 1;
}
// Plafond du texte extrait persisté (fin de la troncature 1 M) et des pages OCR détaillées stockées
// (borne la taille de ligne pour un document de 10 000 pages, sans fausser les agrégats).
const extractionMaxChars = () => clampInt(process.env.REG_EXTRACTION_MAX_CHARS, 20_000_000, 100_000, 200_000_000);
const ocrStoredPages = () => clampInt(process.env.REG_OCR_STORED_PAGES, 5000, 100, 20_000);
// SOUPAPE DE SÉCURITÉ (désactivée par défaut) : pdf-parse (extraction) et mupdf (OCR) chargent le
// PDF ENTIER en mémoire ; sur une instance à faible RAM, un fichier de plusieurs centaines de Mo peut
// provoquer un OOM. Défaut 1000 Mo → au-dessus du plafond de stockage (950 Mo) : aucun fichier n'est
// bloqué en fonctionnement normal (pas de régression). À ABAISSER (ex. 200) sur une petite instance :
// un fichier au-delà est alors marqué REVUE MANUELLE (sans être chargé) pour ne pas bloquer le lot.
/**
 * Taille au-delà de laquelle un fichier part en revue manuelle.
 *
 * Le plafond valait 1 Go (bridé à 4 Go), pour une raison qui n'existe plus : la rastérisation
 * gardait toutes les pages en mémoire. Elle est désormais EN FLUX — une page vit à la fois — donc
 * le nombre de pages n'entre plus en ligne de compte. Ne reste que la taille du fichier lui-même,
 * que mupdf doit ouvrir d'un bloc.
 *
 * Défaut porté à 8 Go, plafond de réglage à 200 Go : ce n'est plus un choix de produit, c'est la
 * mémoire de la machine qui décide. Et quand elle ne suffit pas, on le DIT (avec la taille, le
 * seuil et quoi faire) plutôt que de laisser un document silencieusement de côté.
 */
const maxProcessBytes = () => clampInt(process.env.REG_MAX_PROCESS_MB, 8000, 20, 200_000) * 1024 * 1024;

/**
 * REND LA MAIN À LA BOUCLE D'ÉVÉNEMENTS (macro-tâche). Node est mono-thread : entre deux unités
 * de travail LOURDES (pdf-parse, OCR WASM, jumeau numérique…), on cède la main pour que les autres
 * requêtes HTTP (navigation, messagerie, autres utilisateurs) soient servies IMMÉDIATEMENT →
 * l'application reste fluide PENDANT l'extraction/analyse d'un dossier, au lieu de « geler ».
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Exécute `fn` sur `items` avec au plus `concurrency` traitements EN VOL (pool à curseur partagé).
 * `fn` NE DOIT JAMAIS lever (ici `ocrOne` avale ses erreurs) — le pool n'a donc pas à récupérer.
 * On cède la boucle d'événements entre deux unités pour ne jamais monopoliser le thread.
 */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx);
      await yieldToEventLoop(); // laisser respirer les autres requêtes entre deux documents
    }
  });
  await Promise.all(workers);
}

/**
 * BUDGET DE TRAVAIL D'UN PASSAGE — ce qui a transformé l'attente en analyse.
 *
 * Le planificateur ne se déclenche qu'une fois par minute. Or plusieurs jobs se RE-METTENT EN
 * FILE pour reprendre là où ils s'étaient arrêtés (l'extraction traite un lot de documents, puis
 * repasse la main). Résultat : un dossier de 262 fichiers avançait par paliers d'un lot… toutes
 * les minutes — un quart d'heure d'attente pure, sans que rien ne calcule.
 *
 * Le passage continue donc de travailler TANT QU'IL RESTE DU TRAVAIL, dans une enveloppe de temps
 * bornée. On cède la boucle d'événements entre chaque unité (l'application reste fluide), et le
 * verrou de débounce empêche deux passages de se chevaucher.
 */
const JOBS_BUDGET_MS = clampInt(process.env.REG_JOBS_BUDGET_MS, 120_000, 5_000, 600_000);

/**
 * UN SEUL PASSAGE À LA FOIS DANS LE PROCESSUS — l'oubli qui rendait l'application injoignable.
 *
 * Le planificateur avait bien son verrou de débounce, mais la route « analyser maintenant »
 * (`/api/regulatory/intelligence/process`) appelle ce runner DIRECTEMENT, sans passer par lui.
 * Chaque onglet ouvert, chaque fin de téléversement, chaque rafraîchissement déclenchait donc son
 * propre passage de deux minutes — et chacun prend jusqu'à vingt jobs de front. Trois passages
 * superposés suffisaient à tenir toutes les connexions à la base : les requêtes ordinaires
 * n'obtenaient plus rien, et l'ouverture d'une session de téléversement expirait au bout de 30 s.
 *
 * Un passage déjà en cours fait donc un retour IMMÉDIAT : il n'y a rien à ajouter, le travail est
 * déjà pris en charge, et le budget de temps est le même.
 */
let passInFlight = false;

export async function runDueRegulatoryJobs(max = MAX_JOBS_PER_TICK, budgetMs = JOBS_BUDGET_MS): Promise<void> {
  if (passInFlight) return;
  passInFlight = true;
  try {
    await runPass(max, budgetMs);
  } finally {
    passInFlight = false;
  }
}

async function runPass(max: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // Reprise des jobs bloqués (process interrompu) : verrou expiré → re-QUEUED.
  await prisma.regulatoryJob
    .updateMany({
      where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
      data: { status: "QUEUED", error: "Reprise après verrou expiré." },
    })
    .catch(() => undefined);

  // On enchaîne les tours tant qu'il reste des jobs dus ET du temps : un tour qui n'a rien trouvé
  // met fin au passage (rien à faire), un tour plein enchaîne immédiatement sur le suivant.
  while (Date.now() < deadline) {
    const done = await runOneRound(max);
    if (done === 0) break;
    await yieldToEventLoop();
  }
}

/** Un tour : jusqu'à `max` jobs pris et exécutés. Rend le nombre de jobs réellement pris. */
async function runOneRound(max: number): Promise<number> {
  // PLUSIEURS DOSSIERS EN MÊME TEMPS — mais pas n'importe lesquels.
  //
  // Node est mono-thread. Paralléliser du CALCUL (extraction, OCR WASM, jumeau numérique) ne le
  // rend pas plus rapide : cela se contente de découper le même temps processeur en tranches, et
  // au passage cela fige l'application pour tout le monde. Paralléliser de l'ATTENTE RÉSEAU
  // (appels au modèle, dépôt et suivi des lots), en revanche, divise vraiment le temps total.
  //
  // On sépare donc les deux familles : les jobs d'analyse partent ensemble, les jobs lourds
  // restent à la file. C'est la distinction qui compte, pas le nombre.
  const inFlight: Promise<void>[] = [];
  let claimed = 0;
  for (let i = 0; i < max; i++) {
    const job = await claimNext();
    if (!job) break;
    claimed++;
    if (IO_BOUND_JOBS.has(job.type)) {
      // Attente réseau : on lance et on passe au suivant. `runOne` n'échoue jamais vers l'appelant.
      inFlight.push(runOne(job));
      continue;
    }
    try {
      await dispatch(job);
    } catch (err) {
      await failJob(job, err);
    }
  }
  // On attend les jobs lancés en parallèle : sans cela, le tick rendrait la main pendant que des
  // analyses tournent encore, et le planificateur en relancerait par-dessus.
  await Promise.all(inFlight);
  return claimed;
}

/**
 * Jobs dont le temps est passé À ATTENDRE LE RÉSEAU (appels au modèle) et non à calculer : eux
 * seuls gagnent à tourner ensemble. Les mettre en parallèle divise le temps total d'un lot de
 * dossiers ; y mettre l'extraction ou l'OCR ne ferait que geler l'application.
 */
const IO_BOUND_JOBS = new Set<RegJobType>(["AI_REVIEW", "VISION", "RULES", "FACTS"]);

/** Exécute un job en avalant ses erreurs — un job en panne n'emporte pas les autres du tick. */
async function runOne(job: RegulatoryJob): Promise<void> {
  try {
    await dispatch(job);
  } catch (err) {
    await failJob(job, err).catch(() => undefined);
  }
}

/**
 * Traite UN job précis jusqu'à son état terminal (DONE/FAILED/CANCELLED). Utilisé pour un
 * traitement ciblé (tests, reprise d'un dossier donné) sans toucher au reste de la file.
 */
export async function runRegulatoryJob(jobId: string, maxPasses = 100): Promise<void> {
  for (let i = 0; i < maxPasses; i++) {
    const claimed = await prisma.regulatoryJob.updateMany({
      where: { id: jobId, status: "QUEUED" },
      data: { status: "RUNNING", lockedAt: new Date(), startedAt: new Date(), error: null },
    });
    if (claimed.count === 0) {
      const cur = await prisma.regulatoryJob.findUnique({ where: { id: jobId }, select: { status: true } });
      if (!cur || cur.status !== "QUEUED") return; // terminal ou disparu
      continue;
    }
    const job = await prisma.regulatoryJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    try {
      await dispatch(job);
    } catch (err) {
      await failJob(job, err);
    }
    const after = await prisma.regulatoryJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!after || (after.status !== "QUEUED" && after.status !== "RUNNING")) return;
  }
}

/** Réclame atomiquement le prochain job en file (verrou optimiste anti-double-prise). */
async function claimNext(): Promise<RegulatoryJob | null> {
  const candidate = await prisma.regulatoryJob.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!candidate) return null;
  const claim = await prisma.regulatoryJob.updateMany({
    where: { id: candidate.id, status: "QUEUED" },
    data: { status: "RUNNING", lockedAt: new Date(), startedAt: new Date(), error: null },
  });
  if (claim.count === 0) return null; // pris par un autre passage
  return prisma.regulatoryJob.findUnique({ where: { id: candidate.id } });
}

async function dispatch(job: RegulatoryJob): Promise<void> {
  switch (job.type) {
    case "EXTRACT":
      return handleExtract(job);
    case "OCR":
      return handleOcr(job);
    case "RULES":
      return handleRules(job);
    case "FACTS":
      return handleFacts(job);
    case "SIMULATE":
      return handleSimulate(job);
    case "AI_REVIEW":
      return handleAiReview(job);
    case "VISION":
      return handleVision(job);
    default:
      // Type non encore pris en charge à ce stade → terminal propre (pas de boucle).
      await prisma.regulatoryJob.update({
        where: { id: job.id },
        data: { status: "CANCELLED", error: `Type ${job.type} non pris en charge (phase ultérieure).`, finishedAt: new Date() },
      });
  }
}

async function failJob(job: RegulatoryJob, err: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  const terminal = attempts >= job.maxAttempts;
  await prisma.regulatoryJob
    .update({
      where: { id: job.id },
      data: {
        attempts,
        status: terminal ? "FAILED" : "QUEUED",
        error: message.slice(0, 500),
        finishedAt: terminal ? new Date() : null,
        lockedAt: null,
      },
    })
    .catch(() => undefined);
  if (terminal) {
    await regAudit({
      companyId: job.companyId, actorId: "system", dossierId: job.dossierId,
      action: "JOB_FAILED", detail: `Job ${job.type} en échec définitif : ${message.slice(0, 200)}`,
    });
  }
}

/** EXTRACT : détecte le MIME et extrait le texte des documents sûrs, par lots. */
async function handleExtract(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    return;
  }

  const pending = await prisma.regulatoryDocument.findMany({
    where: {
      dossierVersionId: versionId,
      extractionStatus: "PENDING",
      securityStatus: { in: ["SAFE", "SUSPICIOUS"] },
      blobId: { not: null },
    },
    orderBy: { sizeBytes: "asc" }, // PETITS D'ABORD : un fichier géant ne bloque jamais les autres
    take: EXTRACT_BATCH,
    select: { id: true, ext: true, blobId: true, originalPath: true, originalFilename: true, sizeBytes: true },
  });

  for (const doc of pending) {
    await extractOne(doc);
    await yieldToEventLoop(); // ne pas monopoliser le thread : l'app reste réactive pendant l'extraction
  }

  // Progression + décision de reprise / fin.
  const documentsSurs = { dossierVersionId: versionId, securityStatus: { in: ["SAFE" as const, "SUSPICIOUS" as const] } };
  const [total, remaining] = await Promise.all([
    prisma.regulatoryDocument.count({ where: documentsSurs }),
    prisma.regulatoryDocument.count({ where: { ...documentsSurs, extractionStatus: "PENDING", blobId: { not: null } } }),
  ]);
  const progress = total > 0 ? Math.round(((total - remaining) / total) * 100) : 100;

  if (remaining > 0) {
    // Reprise au prochain tick (sans consommer de tentative) — mémoire/latence bornées.
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "QUEUED", progress, lockedAt: null } });
  } else {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    if (job.dossierId) {
      await prisma.regulatoryDossier.update({ where: { id: job.dossierId }, data: { status: "ANALYSING" } }).catch(() => undefined);
    }
    // Chaîne : EXTRACT → [OCR si scans] → FACTS → RULES. L'OCR (auto-hébergé) océrise les
    // documents scannés AVANT le jumeau numérique pour que leur contenu alimente les faits.
    const ocrPending = ocrEnabled()
      ? await prisma.regulatoryDocument.count({ where: { dossierVersionId: versionId, extractionStatus: "OCR_REQUIRED", blobId: { not: null } } })
      : 0;
    await prisma.regulatoryJob.create({
      data: { companyId: job.companyId, dossierId: job.dossierId, dossierVersionId: versionId, type: ocrPending > 0 ? "OCR" : "FACTS", status: "QUEUED", payload: {} },
    });
  }
}

/**
 * OCR (G13) : océrise les documents scannés (OCR_REQUIRED) — auto-hébergé (tesseract.js +
 * mupdf + sharp, données de langue locales). Par lots bornés (WASM lourd), avec reprise.
 * Le texte OCR est stocké SÉPARÉMENT (method="ocr") ; les pages de faible confiance sont
 * signalées pour REVUE HUMAINE (statut LOW_CONFIDENCE), jamais présumées correctes.
 */
async function handleOcr(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId || !ocrEnabled()) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    if (versionId) await enqueueFacts(job, versionId);
    return;
  }

  const pending = await prisma.regulatoryDocument.findMany({
    where: { dossierVersionId: versionId, extractionStatus: "OCR_REQUIRED", blobId: { not: null } },
    orderBy: { sizeBytes: "asc" }, // petits d'abord (un scan géant ne bloque pas le lot)
    take: ocrBatchSize(),
    select: { id: true, ext: true, blobId: true, originalPath: true, originalFilename: true, sizeBytes: true },
  });

  // Mistral (cloud) → pool parallèle (rapide) ; Tesseract (local) → concurrence 1 (séquentiel).
  await runPool(pending, ocrConcurrency(), (d) => ocrOne(d, { dossierId: job.dossierId, dossierVersionId: versionId }));

  const remaining = await prisma.regulatoryDocument.count({
    where: { dossierVersionId: versionId, extractionStatus: "OCR_REQUIRED", blobId: { not: null } },
  });
  if (remaining > 0) {
    // Reprise au prochain tick (sans consommer de tentative) — mémoire/latence bornées.
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "QUEUED", lockedAt: null } });
  } else {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    await enqueueFacts(job, versionId);
  }
}

/** Enfile le jumeau numérique (FACTS) — étape suivante après extraction/OCR. */
async function enqueueFacts(job: RegulatoryJob, versionId: string): Promise<void> {
  const exists = await prisma.regulatoryJob.count({ where: { dossierVersionId: versionId, type: "FACTS", status: { in: ["QUEUED", "RUNNING"] } } });
  if (exists === 0) {
    await prisma.regulatoryJob.create({ data: { companyId: job.companyId, dossierId: job.dossierId, dossierVersionId: versionId, type: "FACTS", status: "QUEUED", payload: {} } });
  }
}

/** Océrise UN document scanné et persiste texte + confiance + revue. Ne lève jamais. */
async function ocrOne(
  doc: { id: string; ext: string; blobId: string | null; originalFilename: string; sizeBytes: number },
  ctx: { dossierId: string | null; dossierVersionId: string | null },
): Promise<void> {
  try {
    // Garde ANTI-OOM (défense) : un scan trop volumineux (mupdf le chargerait en entier) → revue manuelle.
    if (doc.sizeBytes > maxProcessBytes()) {
      console.warn(`[reg-ocr] ${doc.originalFilename} (${Math.round(doc.sizeBytes / 1048576)} Mo) > seuil ${Math.round(maxProcessBytes() / 1048576)} Mo → revue manuelle.`);
      await prisma.regulatoryDocument.update({ where: { id: doc.id }, data: { extractionStatus: "MANUAL_REVIEW_REQUIRED" } });
      return;
    }
    const buffer = doc.blobId ? await getBlob(doc.blobId) : null;
    if (!buffer || !canOcr(doc.ext)) {
      await prisma.regulatoryDocument.update({ where: { id: doc.id }, data: { extractionStatus: "MANUAL_REVIEW_REQUIRED" } });
      return;
    }
    // SECOURS VISION : les pages restées vides/douteuses après l'OCR sont transcrites par le
    // modèle multimodal (tracé au budget du dossier, en cache) — un scan « illisible » n'est
    // déclaré tel qu'après avoir VRAIMENT tout tenté.
    const r = await ocrDocument({
      ext: doc.ext, buffer,
      aiRescue: { dossierId: ctx.dossierId, dossierVersionId: ctx.dossierVersionId, documentId: doc.id, label: doc.originalFilename },
    });
    const status = r.text.length === 0 ? "MANUAL_REVIEW_REQUIRED" : r.needsReview ? "LOW_CONFIDENCE" : "OCR_COMPLETED";
    // Trace le MOTEUR OCR réellement utilisé (Mistral cloud vs Tesseract local) pour que ce soit
    // VISIBLE côté dossier (sources du jumeau) — on ne pouvait pas savoir lequel avait tourné.
    const ocrMethod = /^mistral/i.test(r.engine) ? "ocr-mistral" : /^tesseract/i.test(r.engine) ? "ocr-tesseract" : "ocr";
    // Texte complet (cap élevé configurable) + détail par page borné (documents de 10 000 pages :
    // on garde tous les agrégats exacts mais on limite le JSON par-page stocké).
    const content = r.text.slice(0, extractionMaxChars());
    const truncated = r.truncated || content.length < r.text.length;
    const ocrPages = r.pages.slice(0, ocrStoredPages());
    const data = {
      method: ocrMethod, lang: r.langs, charCount: content.length, truncated,
      content, ocrConfidence: r.meanConfidence, pageCount: r.pageCount,
      ocrPages: ocrPages as unknown as object, needsReview: r.needsReview,
      // La carte des pages rend chaque constat OUVRABLE à la bonne page du scan.
      pageMap: (r.pageOffsets ?? undefined) as unknown as object,
    };
    await prisma.$transaction([
      prisma.regulatoryExtraction.upsert({ where: { documentId: doc.id }, create: { documentId: doc.id, ...data }, update: data }),
      prisma.regulatoryDocument.update({ where: { id: doc.id }, data: { extractionStatus: status } }),
    ]);
  } catch (err) {
    console.error("[reg-ocr] document", doc.id, err);
    await prisma.regulatoryDocument.update({ where: { id: doc.id }, data: { extractionStatus: "MANUAL_REVIEW_REQUIRED" } }).catch(() => undefined);
  }
}

/** FACTS : jumeau numérique (faits sourcés) + détection de conflits. */
async function handleFacts(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    return;
  }
  const facts = await buildTwinFacts(versionId);
  const conflicts = await detectConflicts(versionId);
  await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
  // Enchaîne les contrôles déterministes (RULES) maintenant que les faits existent.
  await prisma.regulatoryJob.create({
    data: { companyId: job.companyId, dossierId: job.dossierId, dossierVersionId: versionId, type: "RULES", status: "QUEUED", payload: {} },
  });
  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
    action: "FACTS_BUILT",
    detail: `Jumeau numérique : ${facts.facts} fait(s) sourcé(s) (${facts.occurrences} occurrence(s)), ${conflicts} conflit(s) détecté(s).`,
    meta: { ...facts, conflicts },
  });
}

/** RULES : jumeau numérique + moteur déterministe → constats + bilan de conformité. */
async function handleRules(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    return;
  }

  const version = await prisma.regulatoryDossierVersion.findUnique({
    where: { id: versionId },
    select: { dossier: { select: { id: true, procedureType: true, productId: true } } },
  });
  if (!version) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", finishedAt: new Date() } });
    return;
  }

  const docs = await prisma.regulatoryDocument.findMany({
    where: { dossierVersionId: versionId },
    select: { id: true, originalFilename: true, ctdSection: true, ctdModule: true, containedSections: true, securityStatus: true, extractionStatus: true, classificationMethod: true },
  });

  // Rattrapage multi-sections : pour un document déjà lu MAIS sans sections détectées (dossier
  // analysé avant cette fonctionnalité, ou « Relancer l'analyse »), on les calcule depuis le texte
  // déjà stocké (un document à la fois → mémoire bornée) et on les persiste. Corrige les fausses
  // « sections manquantes » d'un gros PDF consolidé sans devoir tout ré-extraire.
  for (const d of docs) {
    await yieldToEventLoop(); // détection de sections = regex lourde sur le texte → céder la main entre docs
    if (d.containedSections.length > 0) continue;
    const ext = await prisma.regulatoryExtraction.findUnique({ where: { documentId: d.id }, select: { content: true } });
    if (!ext?.content) continue;
    const detected = detectContainedSections(ext.content).map((x) => x.code);
    if (detected.length > 0) {
      await prisma.regulatoryDocument.update({ where: { id: d.id }, data: { containedSections: detected } }).catch(() => undefined);
      d.containedSections = detected;
    }
  }

  const twinDocs: TwinDoc[] = docs.map((d) => ({ ...d, securityStatus: String(d.securityStatus), extractionStatus: String(d.extractionStatus) }));

  // G5 : règles administrables du/des pack(s) ACTIF(s) — sinon repli sur les profils codés.
  const [rules, factKeys] = await Promise.all([
    loadActiveRules(version.dossier.procedureType),
    loadPresentFactKeys(versionId),
  ]);
  const { findings, summary } = assessVersion({ procedureType: version.dossier.procedureType, documents: twinDocs, rules, factKeys });

  // NOTICE EN ARABE (spécificité algérienne, décret n° 92-286) : notice/étiquetage (1.3.x hors
  // RCP) sans version arabe → constat MAJEUR. Seuls les textes NATIFS sont jugés — l'OCR latin
  // massacre l'arabe et on refuse d'accuser une notice arabe scannée sur une lecture ratée.
  for (const d of docs) {
    const eligible =
      String(d.securityStatus) === "SAFE" &&
      String(d.extractionStatus) === "TEXT_EXTRACTED" &&
      (isArabicRequiredSection(d.ctdSection) || d.containedSections.some((s) => isArabicRequiredSection(s)));
    if (!eligible) continue;
    await yieldToEventLoop(); // comptage regex sur un gros texte → céder la main entre documents
    const ext = await prisma.regulatoryExtraction.findUnique({ where: { documentId: d.id }, select: { content: true } });
    if (!ext?.content || !missesArabic(ext.content)) continue;
    const { ratio, letters } = arabicStats(ext.content);
    findings.push({
      code: `NOTICE-AR:${d.id}`,
      severity: "MAJOR",
      category: "content",
      title: "Notice / étiquetage sans version arabe",
      detail:
        "La réglementation algérienne (décret exécutif n° 92-286, art. 4) impose une notice et un étiquetage rédigés en arabe. " +
        `Le texte lu de « ${d.originalFilename} » est presque exclusivement en caractères latins. ` +
        "Vérifier si la version arabe existe dans un document séparé du module 1.3 ; sinon, la produire avant dépôt.",
      evidence: `Texte natif analysé : ${letters.toLocaleString("fr-FR")} lettres, dont ${(ratio * 100).toFixed(1)} % en caractères arabes (seuil : 5 %).`,
      sectionCode: d.ctdSection ?? undefined,
      documentId: d.id,
      blocker: false,
    });
  }

  await prisma.$transaction([
    // Recalcul idempotent : on remplace les constats du MOTEUR (on préserve IA/HUMAIN).
    prisma.regulatoryFinding.deleteMany({ where: { dossierVersionId: versionId, source: "RULE" } }),
    prisma.regulatoryFinding.createMany({
      data: findings.map((f) => ({
        dossierVersionId: versionId, code: f.code, severity: f.severity, category: f.category,
        title: f.title, detail: f.detail, evidence: f.evidence ?? null, sectionCode: f.sectionCode ?? null,
        documentId: f.documentId ?? null, source: "RULE" as const, blocker: f.blocker ?? false, draft: false,
      })),
    }),
    prisma.regulatoryAssessment.upsert({
      where: { dossierVersionId: versionId },
      create: {
        dossierVersionId: versionId, completeness: summary.completeness, conforme: summary.conforme,
        blockers: summary.blockers, criticals: summary.criticals, majors: summary.majors, minors: summary.minors,
        requiredPresent: summary.requiredPresent, requiredTotal: summary.requiredTotal, computedAt: new Date(),
      },
      update: {
        completeness: summary.completeness, conforme: summary.conforme,
        blockers: summary.blockers, criticals: summary.criticals, majors: summary.majors, minors: summary.minors,
        requiredPresent: summary.requiredPresent, requiredTotal: summary.requiredTotal, computedAt: new Date(),
      },
    }),
    // Le dossier ne passe PLUS « en revue » ici : les contrôles déterministes ne sont que la
    // moitié du travail. C'est la simulation d'examen — dernière étape — qui clôt l'analyse.
    prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } }),
  ]);

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: version.dossier.id, dossierVersionId: versionId,
    action: "RULES_ASSESSED",
    detail: `Contrôles déterministes : complétude ${summary.completeness}%, ${summary.conforme ? "aucun bloqueur" : `${summary.blockers} bloqueur(s)`} — ${summary.criticals} critique(s), ${summary.majors} majeur(s).`,
    meta: { ...summary },
  });

  // Précédents ANPP attachés aux constats — après persistance, jamais bloquant.
  await attachPrecedents(job, versionId, await enrichmentContextOf(version.dossier.productId));

  // Revue IA (PROJET, non bloquante) uniquement si l'IA est configurée — sinon on n'empile
  // pas de jobs annulés.
  if (aiConfigured()) {
    await prisma.regulatoryJob.create({
      data: { companyId: job.companyId, dossierId: version.dossier.id, dossierVersionId: versionId, type: "AI_REVIEW", status: "QUEUED", payload: {} },
    });
  } else {
    // Sans IA il n'y a ni revue de fond ni simulation : l'analyse s'arrête ici, et le dossier
    // doit quand même arriver « en revue » — sinon il resterait « en analyse » indéfiniment.
    await closeAnalysis(version.dossier.id);
  }
  // EXAMEN VISUEL : figures (courbes, chromatogrammes, schémas) ET contrôle de FORME de chaque
  // page. Séparé de la revue de texte parce qu'il répond à une autre question — « qu'est-ce que
  // je VOIS ? » — sur laquelle l'OCR est structurellement aveugle : le texte d'une capture
  // d'écran est parfaitement propre.
  if (visionEnabled()) {
    await prisma.regulatoryJob.create({
      data: { companyId: job.companyId, dossierId: version.dossier.id, dossierVersionId: versionId, type: "VISION", status: "QUEUED", payload: {} },
    });
  }
}


// ───────────────────────────── VISION : figures + forme des pièces ─────────────────────────────

/** L'examen visuel demande un modèle multimodal ; sans clé, on n'empile pas de job annulé. */
const visionEnabled = () => lunaConfigured() && (process.env.REG_VISION ?? "1").trim() !== "0";
/** Documents dont on regarde les PAGES (les formats bureautiques n'ont pas de page à voir). */
const VISION_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff"]);

/**
 * VISION : ce que le texte ne dira jamais.
 *
 * Deux questions posées à la même image, dans le même appel — rastériser et transmettre les pages
 * est le vrai coût, y ajouter une seconde question est quasi gratuit :
 *
 *   1. **les figures** — courbes de stabilité, chromatogrammes, profils de dissolution, schémas de
 *      procédé. L'OCR les réduit à des axes et des légendes ; la tendance, le point hors
 *      spécification, l'étape manquante disparaissent ;
 *   2. **la forme de la pièce** — capture d'écran collée à la place d'un certificat, photo d'un
 *      écran, scan illisible, filigrane « brouillon », signature absente. **Aucun de ces défauts
 *      n'existe dans le texte** : l'OCR d'une capture d'écran rend un texte impeccable.
 *
 * Les défauts de forme deviennent des constats `category: "form"`, en PROJET non bloquant comme
 * tout ce que produit l'IA : c'est l'humain qui déclare une pièce irrecevable.
 */
async function handleVision(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId || !visionEnabled()) {
    await prisma.regulatoryJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", finishedAt: new Date(), error: visionEnabled() ? "Version absente." : "Examen visuel indisponible (clé OpenAI absente)." },
    });
    return;
  }

  const docs = await prisma.regulatoryDocument.findMany({
    where: { dossierVersionId: versionId, securityStatus: { in: ["SAFE", "SUSPICIOUS"] } },
    orderBy: { sizeBytes: "asc" }, // les petits d'abord : un document géant ne retarde pas le lot
    select: { id: true, originalFilename: true, ext: true, blobId: true, ctdSection: true, sizeBytes: true },
  });

  const findings: {
    documentId: string; severity: string; title: string; detail: string; evidence: string; page: number; confidence: number;
  }[] = [];
  let figuresSeen = 0;
  let pagesSeen = 0;
  let budgetStopped = false;

  for (const d of docs) {
    if (budgetStopped) break;
    if (!VISION_EXTS.has(d.ext.toLowerCase()) || !d.blobId) continue;
    if (d.sizeBytes > maxProcessBytes()) continue; // même garde que l'extraction
    await yieldToEventLoop();

    const buffer = await getBlob(d.blobId).catch(() => null);
    if (!buffer) continue;

    const report = await readFigures({
      buffer, filename: d.originalFilename, ext: d.ext.toLowerCase(), ctdSection: d.ctdSection,
      dossierId: job.dossierId, dossierVersionId: versionId, documentId: d.id,
    });
    figuresSeen += report.observations.length;
    pagesSeen += report.pagesRead;
    if (!report.ok && (report.error ?? "").includes("Budget")) budgetStopped = true;

    for (const df of report.defects) {
      findings.push({
        documentId: d.id,
        severity: FORM_DEFECT_SEVERITY[df.kind],
        title: FORM_DEFECT_LABEL[df.kind],
        detail: `Page ${df.page} de « ${d.originalFilename} » — ${FORM_DEFECT_LABEL[df.kind].toLowerCase()}. `
          + `Une pièce dans cet état est refusée sur la forme, indépendamment de son contenu : il faut fournir le document authentique.`,
        evidence: df.evidence,
        page: df.page,
        confidence: df.confidence,
      });
    }
    // Les observations de figures qui inquiètent l'IA deviennent des constats de FOND sourcés.
    for (const ob of report.observations) {
      for (const c of ob.concerns) {
        findings.push({
          documentId: d.id, severity: "MINOR",
          title: `Figure à vérifier — ${ob.caption ?? ob.kind.toLowerCase().replace(/_/g, " ")}`,
          detail: `${ob.description} — point d'attention : ${c}`,
          evidence: ob.readings.join(" · ").slice(0, 1200) || ob.description.slice(0, 1200),
          page: ob.page, confidence: ob.confidence,
        });
      }
    }
  }

  await prisma.$transaction([
    prisma.regulatoryFinding.deleteMany({ where: { dossierVersionId: versionId, code: "VISION" } }),
    prisma.regulatoryFinding.createMany({
      data: findings.slice(0, aiMaxFindings()).map((f) => ({
        dossierVersionId: versionId, code: "VISION",
        severity: f.severity as "CRITICAL" | "MAJOR" | "MINOR" | "INFO",
        category: "form", title: f.title.slice(0, 200), detail: f.detail.slice(0, 2000),
        evidence: f.evidence.slice(0, 1200), excerpt: f.evidence.slice(0, 1200),
        documentId: f.documentId, source: "AI" as const,
        // Non bloquant : déclarer une pièce irrecevable reste une décision humaine.
        blocker: false, draft: true, page: f.page, confidence: f.confidence,
      })),
    }),
    prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } }),
  ]);

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
    action: "VISION_DONE",
    detail: `Examen visuel : ${pagesSeen} page(s), ${figuresSeen} figure(s) lue(s), ${findings.length} constat(s) de forme/figure (PROJET)`
      + (budgetStopped ? " — ⚠ INTERROMPU : plafond budgétaire atteint, le reste des pages n'a PAS été examiné." : "")
      + ".",
  });
}

// Sections prioritaires (analysées EN PREMIER quand le budget de parts est limité).
const AI_PRIORITY_SECTIONS = new Set(["1.2", "1.3", "2.3", "2.5", "3.2.P.5", "3.2.P.8", "3.2.S.4", "5.3"]);
// Documents lisibles par l'IA (texte natif + OCR, y compris faible confiance pour couverture max).
const AI_REVIEWABLE_STATUSES = ["TEXT_EXTRACTED", "OCR_COMPLETED", "LOW_CONFIDENCE"] as const;
const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2, INFO: 3 };

// Parts d'analyse océrisées EN PARALLÈLE (borne le débit vers l'IA) ; plafond de parts par version
// (coût — 0 = illimité) ; plafond de constats persistés (évite d'inonder l'UI/la base).
/**
 * Parts envoyées EN PARALLÈLE au modèle — 8 (était 4). C'est de l'ATTENTE RÉSEAU pure : doubler
 * le parallélisme divise à peu près par deux le temps de la revue de fond, sans coûter un jeton
 * de plus. Le plafond reste la tolérance du fournisseur (au-delà, des refus pour débit excessif).
 */
const aiConcurrency = () => clampInt(process.env.REG_AI_CONCURRENCY, 8, 1, 24);
/**
 * Parts analysées par version. **0 = INTÉGRAL, et c'est le défaut.**
 *
 * Le plafond valait 120, soit environ 1 200 pages. Sur un dossier de 15 000 pages, 92 % du
 * contenu n'était jamais lu — et la boucle sortait par un simple `break`, sans que rien à
 * l'écran ne distingue « analysé » de « analysé à 8 % ». Un dossier réglementaire à moitié lu
 * qui a l'air complet est pire qu'un dossier non analysé : on s'y fie.
 *
 * Le coût est désormais tenu par le bon outil — le plafond BUDGÉTAIRE du dossier, qui refuse
 * l'appel avant la dépense et le dit — plutôt que par un compteur de parts aveugle.
 */
const aiMaxChunks = () => clampInt(process.env.REG_AI_MAX_CHUNKS, 0, 0, 1_000_000);
const aiMaxFindings = () => clampInt(process.env.REG_AI_MAX_FINDINGS, 3000, 10, 100_000);
/**
 * Voie de la revue de fond : **IMMÉDIATE par défaut**.
 *
 * Le différé (Batch, moitié prix) coûte deux fois moins cher, mais fait attendre les constats
 * jusqu'à 24 h — et pendant ce temps l'écran montre un dossier « en revue » dont il MANQUE la
 * partie la plus exigeante (les constats de fond). Découvrir après coup que l'analyse lue était
 * incomplète est bien plus coûteux que la différence de prix : on paie plein tarif et on voit
 * tout de suite.
 *
 * Le différé reste disponible **à la demande** (bouton « Réanalyser à moitié prix » de l'écran
 * dossier), et peut redevenir le défaut avec `REG_AI_BATCH=1` — utile pour une réanalyse
 * massive lancée le soir.
 */
const aiBatchDefault = () => (process.env.REG_AI_BATCH ?? "0").trim() === "1";

/**
 * AI_REVIEW : revue de fond/forme (PROJET, non bloquante). Chaque document lisible est découpé
 * en PARTS d'environ 10 pages (splitTextIntoChunks) ; chaque part est envoyée SÉPARÉMENT à l'IA,
 * EN PARALLÈLE (borné) — jamais le document entier. Sections prioritaires d'abord. ROBUSTE : une
 * part qui échoue est ignorée (les autres passent). Bornée en coût (REG_AI_MAX_CHUNKS) et en
 * nombre de constats persistés (les plus sévères d'abord). Mémoire bornée : un contenu à la fois.
 */
/**
 * CLÔTURE DE L'ANALYSE — le seul endroit qui fait passer un dossier « en revue ».
 *
 * C'était auparavant l'affaire des contrôles déterministes, qui se terminent bien avant la revue
 * de fond : l'écran annonçait « en revue » alors que la partie la plus exigeante n'avait pas
 * commencé. Le dossier n'est désormais déclaré prêt à relire que lorsque la machine n'a plus rien
 * à en dire — contrôles, revue de fond, et simulation d'examen comprises.
 */
async function closeAnalysis(dossierId: string | null): Promise<void> {
  if (!dossierId) return;
  await prisma.regulatoryDossier
    .update({ where: { id: dossierId }, data: { status: "IN_REVIEW" } })
    .catch(() => undefined); // dossier supprimé entre-temps : rien à clore
}

/**
 * Enchaîne la SIMULATION D'EXAMEN après la revue de fond. Appelée sur le chemin de succès COMME
 * sur celui d'échec : une revue qui a échoué ne doit pas laisser le dossier bloqué « en analyse »
 * pour toujours. Si l'IA n'est pas configurée, il n'y a rien à simuler et on clôt directement.
 */
async function queueSimulation(job: RegulatoryJob, versionId: string): Promise<void> {
  if (!aiConfigured()) {
    await closeAnalysis(job.dossierId);
    return;
  }
  const already = await prisma.regulatoryJob.count({
    where: { dossierVersionId: versionId, type: "SIMULATE", status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (already > 0) return; // une simulation est déjà en file : ne pas en empiler une seconde
  await prisma.regulatoryJob.create({
    data: { companyId: job.companyId, dossierId: job.dossierId, dossierVersionId: versionId, type: "SIMULATE", status: "QUEUED", payload: {} },
  });
}

/**
 * SIMULATE : dix examinateurs simulés passent le dossier en revue (recevabilité, Module 1, qualité,
 * analytique, stabilité, bioéquivalence, clinique, pharmacovigilance, médico-économique,
 * commission) et rendent les questions qu'ils poseraient. C'est la dernière étape de l'analyse :
 * l'analyse dit ce qui ne va pas dans les pièces, la simulation dit ce qu'on va nous demander.
 *
 * Non bloquante : une simulation impossible (IA indisponible) NE doit pas retenir le dossier —
 * elle est tracée, et le dossier passe quand même en revue. L'inverse laisserait un dossier
 * parfaitement analysé coincé pour une carte d'anticipation.
 */
async function handleSimulate(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "CANCELLED", finishedAt: new Date(), error: "Version absente." } });
    await closeAnalysis(job.dossierId);
    return;
  }

  const res = await runReviewerSimulation(versionId, "system").catch((e) => ({
    ok: false as const, configured: true, perspectives: [], error: e instanceof Error ? e.message : String(e),
  }));

  await prisma.regulatoryJob.update({
    where: { id: job.id },
    data: res.ok
      ? { status: "DONE", progress: 100, finishedAt: new Date() }
      : { status: "FAILED", finishedAt: new Date(), error: (res.error ?? "Simulation impossible.").slice(0, 500) },
  });

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
    action: res.ok ? "SIMULATION_DONE" : "SIMULATION_FAILED",
    detail: res.ok
      ? `Simulation d'examen : ${res.perspectives.length} perspective(s) rendues.`
      : `Simulation d'examen impossible : ${res.error ?? "raison inconnue"}. Le dossier passe quand même en revue.`,
  });

  await closeAnalysis(job.dossierId);
}

async function handleAiReview(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId || !aiConfigured()) {
    await prisma.regulatoryJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", finishedAt: new Date(), error: aiConfigured() ? "Version absente." : `${courtIaNonConfiguree(cleModeleRequise())} — aucune revue simulée.` },
    });
    await closeAnalysis(job.dossierId); // ne jamais laisser un dossier bloqué « en analyse »
    return;
  }

  const docs = await prisma.regulatoryDocument.findMany({
    where: { dossierVersionId: versionId, extractionStatus: { in: [...AI_REVIEWABLE_STATUSES] }, securityStatus: { in: ["SAFE", "SUSPICIOUS"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, originalFilename: true, ctdSection: true },
  });
  // Sections prioritaires en tête (tri stable), puis le reste → couverture complète, budget permettant.
  const ordered = [...docs].sort((a, b) => Number(!!b.ctdSection && AI_PRIORITY_SECTIONS.has(b.ctdSection)) - Number(!!a.ctdSection && AI_PRIORITY_SECTIONS.has(a.ctdSection)));

  // ── VOIE DIFFÉRÉE (Batch, moitié prix) — désormais SUR DEMANDE, plus par défaut : elle fait
  // attendre les constats jusqu'à 24 h, pendant lesquelles l'écran montre un dossier « en revue »
  // amputé de sa partie la plus exigeante. On passe donc directement à la voie immédiate
  // ci-dessous, sauf réglage explicite (`REG_AI_BATCH=1`) ou demande de l'utilisateur.
  // Le mode peut être FORCÉ par la charge utile du job (choix à l'écran) : « résultats
  // maintenant, plein tarif » l'emporte toujours.
  const forcedImmediate = (job.payload as { mode?: string } | null)?.mode === "immediate";
  if (!forcedImmediate && aiBatchDefault()) {
    const submitted = await submitVersionReviewBatch(versionId, {
      companyId: job.companyId, dossierId: job.dossierId, userId: null,
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

    if (submitted.ok) {
      await prisma.regulatoryJob.update({
        where: { id: job.id },
        data: { status: "DONE", progress: 100, finishedAt: new Date() },
      });
      await regAudit({
        companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
        action: "AI_REVIEW_DEFERRED",
        detail: submitted.message ?? "Analyse différée déposée (moitié prix). Les constats arriveront sous 24 h.",
      });
      await queueSimulation(job, versionId);
      return;
    }
    console.warn("[reg-ai] dépôt différé impossible, repli sur la voie immédiate :", submitted.error);
  }

  const maxChunks = aiMaxChunks();
  const concurrency = aiConcurrency();
  const collected: (AiFinding & { documentId: string })[] = [];
  let usedChunks = 0;
  let analyzedDocs = 0;
  /** Une part refusée faute de budget arrête l'analyse : continuer produirait un trou silencieux. */
  let budgetStopped = false;
  /**
   * Parts réellement LUES vs parts en ÉCHEC, et la première raison d'échec.
   *
   * Sans ce comptage, une panne totale (clé invalide, quota épuisé, fournisseur indisponible)
   * se terminait en « job DONE, 0 constat » : le dossier avait l'air impeccable alors que
   * l'analyse n'avait jamais eu lieu. C'est le pire des résultats possibles — on s'y fie.
   */
  let okParts = 0;
  let failedParts = 0;
  let firstError: string | null = null;

  for (const d of ordered) {
    if (maxChunks > 0 && usedChunks >= maxChunks) break;
    await yieldToEventLoop(); // céder la main entre documents (découpage + appels IA)
    // Contenu chargé UN document à la fois (pic mémoire borné même pour un document de 10 000 pages).
    const ext = await prisma.regulatoryExtraction.findUnique({ where: { documentId: d.id }, select: { content: true, pageMap: true } });
    const pageMap = Array.isArray(ext?.pageMap) ? (ext!.pageMap as number[]) : null;
    let parts = splitTextIntoChunksWithOffsets(ext?.content ?? "");
    if (parts.length === 0) continue;
    if (maxChunks > 0) parts = parts.slice(0, maxChunks - usedChunks);
    usedChunks += parts.length;
    analyzedDocs++;
    const ctdTitle = d.ctdSection ? sectionByCode(d.ctdSection)?.title ?? null : null;
    // Les textes opposables de CETTE section, cherchés UNE fois et partagés par toutes ses parts :
    // même contexte, donc même empreinte de cache — un document inchangé n'est pas repayé.
    const corpus = await corpusForSection(d.ctdSection);
    // L'expérience interne (module Entraînement IA) : ce que l'ANPP a réellement dit sur NOS
    // produits passés pour cette section — précédents, jamais règles.
    const experience = await experienceForSection(d.ctdSection);
    const total = parts.length;
    // L'en-tête du document (page de garde : produit, dosage, forme) accompagne chaque part —
    // sans lui, la part 8/12 juge un tableau sans savoir de quoi il parle. Pas pour la part 1,
    // qui le contient déjà.
    const docLead = total > 1 ? parts[0].text.slice(0, 1200) : null;
    const content = ext?.content ?? "";
    // Parts de CE document envoyées à l'IA en parallèle ; une part en échec n'arrête pas les autres.
    await runPool(parts, concurrency, async (part, i) => {
      if (budgetStopped) return;
      try {
        // Pages EXACTES quand la carte existe (extraction paginée) ; estimation sinon.
        const span = pageMap ? pageSpanOfSlice(pageMap, part.start, part.end) : chunkPageSpan(i);
        const r = await reviewDocumentText(
          {
            filename: total > 1 ? `${d.originalFilename} — partie ${i + 1}/${total}` : d.originalFilename,
            ctdSection: d.ctdSection, ctdTitle, text: part.text, corpus, experience,
            pageStart: span.start, pageEnd: span.end,
            docLead: i > 0 ? docLead : null,
          },
          // TRACÉ : chaque part est imputée au dossier, à la version et au fichier, et le plafond
          // budgétaire refuse l'appel AVANT la dépense (cf. review-ai.ts).
          lunaReviewFn({ dossierId: job.dossierId, dossierVersionId: versionId, documentId: d.id, step: "review" }),
        );
        if (r.ok) {
          okParts++;
          for (const f of r.findings) {
            // L'ANCRAGE PRIME SUR L'ESTIMATION : si la preuve citée se retrouve dans le texte,
            // sa page devient LA page — celle qu'on ouvre au clic, celle qu'on montre en séance.
            const anchored = pageMap ? anchorEvidence(content, pageMap, f.evidence) : null;
            collected.push({ ...f, page: anchored ?? f.page, documentId: d.id });
          }
        } else {
          failedParts++;
          firstError ??= r.error ?? "raison inconnue";
          if ((r.error ?? "").includes("Budget IA")) budgetStopped = true;
        }
      } catch (err) {
        failedParts++;
        firstError ??= err instanceof Error ? err.message : String(err);
        console.error("[reg-ai] analyse d'une part échouée", d.id, i, err instanceof Error ? err.message : err);
      }
    });
    if (budgetStopped) break;
  }

  // ── PANNE TOTALE : aucune part n'a pu être lue. Ce n'est PAS un dossier sans reproche.
  // On ne détruit pas les constats existants, on marque le job en échec avec sa raison, et on
  // prévient — un « terminé, 0 constat » silencieux ferait croire à un dossier impeccable.
  if (okParts === 0 && failedParts > 0) {
    const reason = firstError ?? "raison inconnue";
    await prisma.regulatoryJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: `Revue de fond impossible (${failedParts} lecture(s) en échec) : ${reason}`.slice(0, 500) },
    });
    await regAudit({
      companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
      action: "AI_REVIEW_FAILED",
      detail: `⚠ La revue de fond n'a RIEN pu lire : ${failedParts} lecture(s) en échec — ${reason}. Aucun constat n'a été produit et les constats précédents sont CONSERVÉS. Ce dossier n'a pas été examiné sur le fond.`,
    }).catch(() => undefined);
    await notifyAiReviewOutcome(job, versionId, {
      title: "Revue de fond impossible",
      body: `La lecture de fond du dossier a échoué (${reason.slice(0, 120)}). Le dossier n'a PAS été examiné sur le fond.`,
    });
    // Même en échec, la suite doit avoir lieu : sans cela le dossier resterait « en analyse »
    // pour toujours, et l'utilisateur attendrait un écran qui ne changera plus jamais.
    await queueSimulation(job, versionId);
    return;
  }

  // Dédoublonne (même document + même titre) puis garde les constats les PLUS SÉVÈRES (plafond).
  const seen = new Set<string>();
  const deduped = collected.filter((f) => {
    const key = `${f.documentId}|${f.title.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const kept = deduped.slice(0, aiMaxFindings());

  await prisma.$transaction([
    prisma.regulatoryFinding.deleteMany({ where: { dossierVersionId: versionId, source: "AI" } }),
    prisma.regulatoryFinding.createMany({
      data: kept.map((f) => ({
        dossierVersionId: versionId, code: "AI_REVIEW", severity: f.severity, category: f.category.slice(0, 40),
        title: f.title.slice(0, 200), detail: f.detail.slice(0, 2000), evidence: f.evidence ? f.evidence.slice(0, 1200) : null,
        sectionCode: f.sectionCode, documentId: f.documentId, source: "AI" as const, blocker: false, draft: true,
        // Ce qui rend le constat défendable : la pièce, le degré de certitude, et quoi faire.
        excerpt: f.evidence ? f.evidence.slice(0, 1200) : null,
        page: f.page, confidence: f.confidence, recommendation: f.recommendation,
        conflictingValues: f.conflictingValues,
      })),
    }),
    prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } }),
  ]);

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
    action: "AI_REVIEW_DONE",
    // « Incomplète » se dit, toujours. Un dossier lu à moitié qui a l'air complet est pire qu'un
    // dossier non analysé, parce qu'on s'y fie.
    detail: `Revue IA (PROJET — revue humaine requise) : ${kept.length} constat(s) sur ${usedChunks} part(s) de ${analyzedDocs} document(s)`
      + (failedParts > 0 ? ` — ⚠ ${failedParts} part(s) n'ont PAS pu être lues (${firstError ?? "raison inconnue"})` : "")
      + (budgetStopped ? " — ⚠ ANALYSE INCOMPLÈTE : plafond budgétaire du dossier atteint, le reste n'a PAS été lu. Relevez le plafond et relancez." : "")
      + (!budgetStopped && maxChunks > 0 && usedChunks >= maxChunks ? ` — ⚠ ANALYSE INCOMPLÈTE : plafond de ${maxChunks} parts atteint (REG_AI_MAX_CHUNKS), le reste n'a PAS été lu.` : "")
      + ".",
  });

  // LA FIN DE L'ANALYSE SE DIT. Sans cela, une revue lancée puis oubliée reste invisible : le
  // pharmacien n'a aucune raison de revenir sur l'écran au bon moment.
  await notifyAiReviewOutcome(job, versionId, {
    title: kept.length > 0 ? "Analyse de fond terminée" : "Analyse de fond terminée — aucun constat",
    body: kept.length > 0
      ? `${kept.length} constat(s) de fond à relire (PROJET — revue humaine requise) sur ${analyzedDocs} document(s).`
      : `Aucun écart relevé sur ${analyzedDocs} document(s) lus. À confirmer par une relecture humaine.`,
  });

  const productId = job.dossierId
    ? (await prisma.regulatoryDossier.findUnique({ where: { id: job.dossierId }, select: { productId: true } }))?.productId ?? null
    : null;
  await attachPrecedents(job, versionId, await enrichmentContextOf(productId));

  // Là où le balayage a trouvé du CRITIQUE, l'agent spécialiste repasse — automatiquement.
  await escalateCriticalSections(versionId, { companyId: job.companyId, dossierId: job.dossierId });

  // DERNIÈRE ÉTAPE de l'analyse : ce que les examinateurs vont probablement demander.
  await queueSimulation(job, versionId);
}

/**
 * PRÉVIENT à la fin d'une revue de fond — succès, silence ou panne.
 *
 * La revue tourne en arrière-plan, parfois de longues minutes : sans notification, son résultat
 * n'existe que pour qui pense à rouvrir l'écran au bon moment. On prévient donc les rôles
 * superviseurs du module (réglage `regulatorySupervisorRoles`) et le Super Admin.
 * Ne lève jamais : une notification ratée n'annule pas une analyse réussie.
 */
async function notifyAiReviewOutcome(
  job: RegulatoryJob,
  versionId: string,
  msg: { title: string; body: string },
): Promise<void> {
  try {
    if (!job.dossierId) return;
    const dossier = await prisma.regulatoryDossier.findUnique({
      where: { id: job.dossierId },
      select: { reference: true, title: true },
    });
    const roles = (await getAppSettings().catch(() => null))?.regulatorySupervisorRoles ?? [];
    await notifyRoles([...new Set([...roles, "SUPER_ADMIN"])] as never, {
      type: "GENERIC",
      title: msg.title,
      body: `${dossier ? `${dossier.reference} — ${dossier.title} : ` : ""}${msg.body}`,
      link: `/regulatory/enregistrement/analyse/${job.dossierId}`,
    });
  } catch (e) {
    console.error("[reg-ai] notification de fin de revue impossible", versionId, e);
  }
}

/**
 * DCI et fournisseur du dossier : ils affinent la recherche de précédents ANPP (« cette réserve,
 * l'avons-nous déjà eue SUR CETTE MOLÉCULE, chez CE fournisseur ? »). Un dossier sans produit
 * rattaché cherche sans filtre — moins précis, mais jamais bloquant.
 */
async function enrichmentContextOf(productId: string | null): Promise<EnrichmentContext> {
  if (!productId) return {};
  const p = await prisma.regulatoryProduct
    .findUnique({ where: { id: productId }, select: { dci: true, partnerLab: true } })
    .catch(() => null);
  return { dci: p?.dci ?? null, supplier: p?.partnerLab ?? null };
}

/**
 * Attache à chaque constat les réserves ANPP comparables et la probabilité qu'elle revienne.
 *
 * Volontairement APRÈS la persistance et hors transaction : c'est un enrichissement, pas une
 * condition. Un échec ici laisse l'analyse complète et exploitable — on perd seulement la
 * mémoire des précédents, qu'un « Relancer l'analyse » rattrapera.
 *
 * ⚠️ Ces précédents n'aggravent jamais la sévérité d'un constat : « l'ANPP nous l'a déjà
 * reproché » informe la préparation, ce n'est pas une règle de droit.
 */
async function attachPrecedents(job: RegulatoryJob, versionId: string, ctx: EnrichmentContext): Promise<void> {
  try {
    const n = await enrichVersionFindings(versionId, ctx);
    if (n > 0) {
      await regAudit({
        companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
        action: "FINDINGS_ENRICHED",
        detail: `${n} constat(s) rapproché(s) de réserves ANPP déjà reçues. Précédents à titre indicatif — aucune sévérité n'a été modifiée.`,
      });
    }
  } catch (err) {
    console.error("[reg-ai] rapprochement des précédents impossible", versionId, err);
  }
}

interface ExtractDoc { id: string; ext: string; blobId: string | null; originalPath: string; originalFilename: string; sizeBytes: number }

/**
 * Extrait un document (MIME + texte) PUIS le classe (CTD déterministe, avec le texte en main).
 * Persiste statut + MIME + classification + nom suggéré. Ne lève jamais (statut d'erreur sinon).
 */
async function extractOne(doc: ExtractDoc): Promise<void> {
  const documentId = doc.id;
  try {
    // Garde ANTI-OOM : un fichier trop volumineux n'est même pas chargé (pdf-parse/mupdf le liraient
    // en entier) → marqué revue manuelle. Les autres fichiers du dossier continuent.
    if (doc.sizeBytes > maxProcessBytes()) {
      console.warn(`[reg-extract] ${doc.originalFilename} (${Math.round(doc.sizeBytes / 1048576)} Mo) > seuil ${Math.round(maxProcessBytes() / 1048576)} Mo → revue manuelle (augmenter REG_MAX_PROCESS_MB / la RAM, ou scinder le PDF).`);
      await prisma.regulatoryDocument.update({ where: { id: documentId }, data: { extractionStatus: "MANUAL_REVIEW_REQUIRED" } });
      return;
    }
    const buffer = doc.blobId ? await getBlob(doc.blobId) : null;
    if (!buffer) {
      await prisma.regulatoryDocument.update({ where: { id: documentId }, data: { extractionStatus: "CORRUPTED" } });
      return;
    }
    const mime = detectMime(buffer, doc.ext);
    const result = await extractText(doc.ext, buffer);

    // Classification CTD déterministe (chemin/nom + texte extrait) — proposition.
    const cls = classifyDocument({ path: doc.originalPath, filename: doc.originalFilename, ext: doc.ext, textSample: result.text });
    // MULTI-SECTIONS : sections CTD réellement présentes dans le TEXTE (PDF consolidé « Module X.pdf »).
    const contained = detectContainedSections(result.text).map((d) => d.code);

    await prisma.$transaction([
      prisma.regulatoryDocument.update({
        where: { id: documentId },
        data: {
          extractionStatus: result.status,
          detectedMimeType: mime.mime,
          ctdModule: cls.module,
          ctdSection: cls.section,
          containedSections: contained,
          ctdConfidence: cls.confidence,
          classificationMethod: cls.method,
          suggestedFilename: cls.suggestedFilename,
        },
      }),
      ...(result.text
        ? [
            prisma.regulatoryExtraction.upsert({
              where: { documentId },
              create: { documentId, method: result.method, lang: result.lang ?? null, charCount: result.chars, truncated: result.truncated, content: result.text, pageMap: (result.pageOffsets ?? undefined) as object | undefined },
              update: { method: result.method, lang: result.lang ?? null, charCount: result.chars, truncated: result.truncated, content: result.text, pageMap: (result.pageOffsets ?? undefined) as object | undefined },
            }),
          ]
        : []),
    ]);
  } catch (err) {
    console.error("[reg-extract] document", documentId, err);
    await prisma.regulatoryDocument
      .update({ where: { id: documentId }, data: { extractionStatus: "MANUAL_REVIEW_REQUIRED" } })
      .catch(() => undefined);
  }
}
