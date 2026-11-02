import { prisma } from "@/lib/prisma";
import { aiConfigured } from "@/lib/ai";
import { BATCH_FRESH_MS } from "../jobs/catchup";
import { computeAnalysisProgress, type AnalysisProgress } from "./analysis-progress";

/**
 * ASSEMBLE l'entrée de la progression depuis la base, puis délègue au calcul PUR.
 *
 * On lit des COMPTES (pas les documents entiers) : la carte se rafraîchit toutes les quelques
 * secondes, elle doit rester bon marché même sur un dossier de 262 fichiers. Le « départ » de
 * l'analyse est le plus ancien job de la version — stable (contrairement à `startedAt` d'un job
 * qui reprend à chaque tick), donc l'ETA se calcule sur le temps mural réellement écoulé.
 */

const BATCH_IN_FLIGHT = ["submitted", "validating", "in_progress", "finalizing"] as const;

export interface AnalysisProgressResult extends AnalysisProgress {
  /** Vrai tant que la machine a quelque chose à faire (pour décider d'afficher la carte + polling). */
  running: boolean;
  /**
   * Raison de l'échec de la DERNIÈRE revue de fond, quand elle a échoué. Affichée telle quelle :
   * une analyse qui n'a pas eu lieu doit se voir à l'écran, pas seulement dans le journal.
   */
  aiFailure: string | null;
  /** La dernière revue de fond a abouti sans relever le moindre écart. */
  aiFoundNothing: boolean;
}

export async function getAnalysisProgress(versionId: string, dossierStatus: string): Promise<AnalysisProgressResult> {
  const documentsSurs = { dossierVersionId: versionId, securityStatus: { in: ["SAFE" as const, "SUSPICIOUS" as const] } };

  // Un lot déposé il y a plus de 26 h ne reviendra plus (les lots aboutissent sous 24 h) : le
  // compter comme « en vol » ferait mentir l'écran indéfiniment.
  const batchFreshSince = new Date(Date.now() - BATCH_FRESH_MS);

  const [docsTotal, docsPending, ocrTotal, ocrDone, factsJob, rulesJob, aiReviewJob, simJob, batchPending, firstJob] = await Promise.all([
    prisma.regulatoryDocument.count({ where: documentsSurs }),
    prisma.regulatoryDocument.count({ where: { ...documentsSurs, extractionStatus: "PENDING", blobId: { not: null } } }),
    prisma.regulatoryDocument.count({ where: { dossierVersionId: versionId, extractionStatus: { in: ["OCR_REQUIRED", "OCR_COMPLETED"] } } }),
    prisma.regulatoryDocument.count({ where: { dossierVersionId: versionId, extractionStatus: "OCR_COMPLETED" } }),
    prisma.regulatoryJob.findFirst({ where: { dossierVersionId: versionId, type: "FACTS" }, select: { status: true } }),
    prisma.regulatoryJob.findFirst({ where: { dossierVersionId: versionId, type: "RULES" }, select: { status: true } }),
    prisma.regulatoryJob.findFirst({ where: { dossierVersionId: versionId, type: "AI_REVIEW" }, orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true, startedAt: true, error: true, finishedAt: true } }),
    prisma.regulatoryJob.findFirst({ where: { dossierVersionId: versionId, type: "SIMULATE" }, orderBy: { createdAt: "desc" }, select: { status: true } }),
    prisma.regulatoryAiBatch.count({ where: { dossierVersionId: versionId, status: { in: [...BATCH_IN_FLIGHT] }, submittedAt: { gte: batchFreshSince } } }),
    prisma.regulatoryJob.findFirst({ where: { dossierVersionId: versionId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  // Un job en attente/en cours = pipeline vivant ; l'assessment (RULES) marque la fin déterministe.
  const activeJobs = await prisma.regulatoryJob.count({
    where: { dossierVersionId: versionId, status: { in: ["QUEUED", "RUNNING"] }, type: { in: ["INGEST", "EXTRACT", "OCR", "FACTS", "RULES", "AI_REVIEW", "VISION", "SIMULATE"] } },
  });

  // Un document « résolu » pour la phase de LECTURE = tout ce qui n'est plus en attente
  // (texte extrait, scan identifié à océriser, ou écarté). Robuste sans énumérer les statuts.
  const docsResolved = Math.max(0, docsTotal - docsPending);
  const aiInPipeline = aiConfigured();

  // ── LA REVUE DE FOND EN COURS : quand un job de revue tourne, c'est LUI le travail courant —
  // un vieux lot différé ne doit plus faire écrire « résultats sous 24 h » ni figer la barre.
  const aiJobActive = aiReviewJob != null && (aiReviewJob.status === "QUEUED" || aiReviewJob.status === "RUNNING");
  const aiStartedAt = aiReviewJob?.startedAt ?? aiReviewJob?.createdAt ?? null;
  // Avancement RÉEL de cette revue : chaque appel de relecture est tracé au fichier près
  // (registre de coût). On compte les fichiers déjà relus DEPUIS le début de cette revue.
  const [aiDocsTotal, reviewedRows] = aiJobActive
    ? await Promise.all([
        prisma.regulatoryDocument.count({
          where: { ...documentsSurs, extractionStatus: { in: ["TEXT_EXTRACTED", "OCR_COMPLETED", "LOW_CONFIDENCE"] } },
        }),
        prisma.regulatoryAiCall.findMany({
          where: { dossierVersionId: versionId, step: "review", documentId: { not: null }, ...(aiStartedAt ? { createdAt: { gte: aiStartedAt } } : {}) },
          select: { documentId: true },
          distinct: ["documentId"],
          take: 5000,
        }),
      ])
    : [0, [] as { documentId: string | null }[]];

  const progress = computeAnalysisProgress({
    dossierStatus,
    docsTotal,
    docsResolved,
    docsPending,
    ocrTotal,
    ocrDone,
    factsDone: factsJob?.status === "DONE",
    rulesDone: rulesJob?.status === "DONE",
    aiInPipeline,
    aiReviewDone: aiReviewJob ? aiReviewJob.status === "DONE" || aiReviewJob.status === "CANCELLED" : !aiInPipeline,
    // « Différé » UNIQUEMENT si un lot récent est en vol ET qu'aucune revue immédiate ne tourne.
    aiBatchPending: batchPending > 0 && !aiJobActive,
    aiJobActive,
    aiFailed: aiReviewJob?.status === "FAILED",
    // La simulation ne fait partie du parcours que si l'IA est là ET qu'un job existe : sur les
    // dossiers analysés AVANT ce lot, il n'y en a pas, et inventer une étape ferait reculer la barre.
    simInPipeline: aiInPipeline && simJob != null,
    simDone: simJob?.status === "DONE" || simJob?.status === "CANCELLED",
    simActive: simJob?.status === "QUEUED" || simJob?.status === "RUNNING",
    simFailed: simJob?.status === "FAILED",
    aiDocsReviewed: reviewedRows.length,
    aiDocsTotal,
    aiStartedAtMs: aiStartedAt?.getTime() ?? null,
    startedAtMs: firstJob?.createdAt.getTime() ?? null,
    nowMs: Date.now(),
  });

  // « running » : il reste des jobs actifs, OU un lot différé en vol, OU le dossier est encore
  // en phase d'ingestion/analyse sans assessment. Sert à afficher la carte et à décider du polling.
  const running = !progress.complete && (activeJobs > 0 || batchPending > 0 || dossierStatus === "INGESTING" || dossierStatus === "INGESTED" || dossierStatus === "ANALYSING");

  // Une revue de fond qui a ÉCHOUÉ, ou qui s'est terminée SANS aucun constat, doit se voir :
  // les deux cas donnent un écran vide, mais ils ne veulent pas dire la même chose du tout.
  const aiFailure = aiReviewJob?.status === "FAILED" ? (aiReviewJob.error ?? "Raison non enregistrée.") : null;
  const aiFindings = aiInPipeline
    ? await prisma.regulatoryFinding.count({ where: { dossierVersionId: versionId, source: "AI" } })
    : 0;
  const aiFoundNothing = aiReviewJob?.status === "DONE" && aiFindings === 0;

  return { ...progress, running, aiFailure, aiFoundNothing };
}
