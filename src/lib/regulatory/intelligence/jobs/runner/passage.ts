/**
 * Runner réglementaire — LE PASSAGE : un passage borné à la fois (`runDueRegulatoryJobs`), tours
 * de jobs, prise optimiste d'un job, aiguillage vers son handler, échec et réessais bornés.
 */
import type { RegulatoryJob, RegJobType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { regAudit } from "../../audit";
import { sansBloquer } from "@/lib/journal";
import { JOBS_BUDGET_MS, MAX_JOBS_PER_TICK, STALE_LOCK_MS, yieldToEventLoop } from "./reglages";
import { handleExtract, handleFacts, handleOcr, handleVision } from "./extraction";
import { handleAiReview, handleRules, handleSimulate } from "./revue-ia";

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
    .catch(sansBloquer("jobs-runner.runPass.regulatoryJob"));

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
    await failJob(job, err).catch(sansBloquer("jobs-runner.runOne.failJob"));
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
    .catch(sansBloquer("jobs-runner.failJob.regulatoryJob"));
  if (terminal) {
    await regAudit({
      companyId: job.companyId, actorId: "system", dossierId: job.dossierId,
      action: "JOB_FAILED", detail: `Job ${job.type} en échec définitif : ${message.slice(0, 200)}`,
    });
  }
}
