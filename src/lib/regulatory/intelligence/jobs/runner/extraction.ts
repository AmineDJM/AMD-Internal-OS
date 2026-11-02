/**
 * Runner réglementaire — L'EXTRACTION : handlers EXTRACT (texte, par lots), OCR (pages scannées),
 * FACTS (faits du jumeau) et VISION (lecture des figures, défauts de forme) — tout ce qui relit le
 * fichier stocké —, avec l'extraction d'un document.
 */
import type { RegulatoryJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { extractText } from "../../extract/extract-text";
import { detectMime } from "@/lib/storage/mime";
import { classifyDocument } from "../../ctd/classify";
import { detectContainedSections } from "../../ctd/detect-sections";
import { ocrDocument, canOcr } from "../../ocr/ocr-engine";
import { buildTwinFacts } from "../../twin/build-facts";
import { detectConflicts } from "../../twin/detect-conflicts";
import { readFigures, FORM_DEFECT_LABEL, FORM_DEFECT_SEVERITY } from "../../vision/read-figures";
import { lunaConfigured } from "@/lib/openai-luna";
import { regAudit } from "../../audit";
import { sansBloquer } from "@/lib/journal";
import { EXTRACT_BATCH, extractionMaxChars, maxProcessBytes, ocrBatchSize, ocrConcurrency, ocrEnabled, ocrStoredPages, runPool, yieldToEventLoop } from "./reglages";
import { aiMaxFindings } from "./revue-ia";

/** EXTRACT : détecte le MIME et extrait le texte des documents sûrs, par lots. */
export async function handleExtract(job: RegulatoryJob): Promise<void> {
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
      await prisma.regulatoryDossier.update({ where: { id: job.dossierId }, data: { status: "ANALYSING" } }).catch(sansBloquer("jobs-runner.handleExtract.regulatoryDossier"));
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
export async function handleOcr(job: RegulatoryJob): Promise<void> {
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
    await prisma.regulatoryDocument.update({ where: { id: doc.id }, data: { extractionStatus: "MANUAL_REVIEW_REQUIRED" } }).catch(sansBloquer("jobs-runner.ocrOne.regulatoryDocument"));
  }
}

/** FACTS : jumeau numérique (faits sourcés) + détection de conflits. */
export async function handleFacts(job: RegulatoryJob): Promise<void> {
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

// ───────────────────────────── VISION : figures + forme des pièces ─────────────────────────────

/** L'examen visuel demande un modèle multimodal ; sans clé, on n'empile pas de job annulé. */
export const visionEnabled = () => lunaConfigured() && (process.env.REG_VISION ?? "1").trim() !== "0";

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
export async function handleVision(job: RegulatoryJob): Promise<void> {
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

    const buffer = await getBlob(d.blobId).catch(sansBloquer("jobs-runner.handleVision.getBlob", null));
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
      .catch(sansBloquer("jobs-runner.extractOne.regulatoryDocument"));
  }
}
