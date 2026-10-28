import { prisma } from "@/lib/prisma";
import {
  type Recurrence,
  type RunStatus,
  nextRunAt,
  RUN_HISTORY_KEEP,
  STALE_CLAIM_MS,
} from "./contract";
import { workflowHandler } from "./registry";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BOUCLE DU PLANIFICATEUR — prendre, exécuter, consigner, replanifier.
 *
 * ── LA PRISE EST ATOMIQUE, ET C'EST LE CŒUR DU SUJET ─────────────────────────────────────
 *
 * Plusieurs instances du serveur tournent. Sans verrou, toutes verraient la même planification
 * due et l'exécuteraient toutes — le rapport du dimanche partirait en trois exemplaires. La prise
 * se fait donc par un `updateMany` conditionné sur `claimedAt: null` : la base arbitre, une seule
 * mise à jour touche une ligne, les autres en touchent zéro et passent leur chemin. C'est le même
 * motif que la file de la couche de connaissance, pour la même raison.
 *
 * ── ON REPLANIFIE AVANT D'EXÉCUTER ───────────────────────────────────────────────────────
 *
 * `nextRunAt` est avancé au moment de la PRISE, pas après le traitement. Si le processus meurt en
 * plein travail, la planification a déjà sa prochaine échéance : elle reprendra au tour suivant
 * au lieu d'être immédiatement due et de rejouer en boucle un traitement qui plante.
 *
 * ── UNE PLANIFICATION QUI ÉCHOUE N'EST JAMAIS DÉSACTIVÉE EN DOUCE ────────────────────────
 *
 * Elle consigne son échec et réessaie à l'échéance suivante. Éteindre automatiquement une
 * planification après quelques erreurs, c'est faire disparaître un rapport hebdomadaire sans que
 * personne ne soit prévenu — l'utilisateur constate l'absence trois semaines plus tard.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Planifications traitées par passage. Petit : le planificateur ne monopolise pas le serveur. */
const BATCH = 3;

export function schedulerEnabled(): boolean {
  return process.env.WORKFLOW_SCHEDULER !== "off";
}

export interface SchedulerSweep {
  ran: number;
  failed: number;
  skipped: number;
  released: number;
}

/**
 * UN PASSAGE. Ne lève jamais : le planificateur horaire enchaîne d'autres balayages derrière.
 */
export async function runScheduledWorkflows(now: Date = new Date(), batch = BATCH): Promise<SchedulerSweep> {
  const out: SchedulerSweep = { ran: 0, failed: 0, skipped: 0, released: 0 };
  if (!schedulerEnabled()) return out;

  try {
    out.released = await releaseStale(now);

    for (let i = 0; i < batch; i += 1) {
      const wf = await claimDue(now);
      if (!wf) break;

      const started = Date.now();
      let status: RunStatus = "OK";
      let summary: string | null = null;
      let error: string | null = null;

      try {
        const handler = workflowHandler(wf.kind);
        if (!handler) {
          // CLÉ INCONNUE. On ne devine pas, on ne tente rien : on le consigne. C'est le cas d'une
          // planification créée pour un traitement retiré depuis — ou d'une clé écrite à la main
          // dans la base, que le registre fermé rend inoffensive.
          status = "SKIPPED";
          summary = `Traitement « ${wf.kind} » inconnu du registre — rien n'a été exécuté.`;
        } else {
          const r = await handler.run({
            workflowId: wf.id,
            ownerId: wf.ownerId,
            payload: (wf.payload as Record<string, unknown> | null) ?? {},
            now,
          });
          status = r.didWork ? "OK" : "SKIPPED";
          summary = r.summary;
        }
      } catch (err) {
        status = "FAILED";
        error = err instanceof Error ? err.message : String(err);
      }

      await recordRun(wf.id, { status, summary, error, ms: Date.now() - started, startedAt: new Date(started) });
      // Le verrou tombe dans tous les cas — y compris après un échec, sinon la planification
      // resterait bloquée jusqu'au délai de péremption pour une erreur d'une seconde.
      await prisma.scheduledWorkflow
        .update({ where: { id: wf.id }, data: { claimedAt: null, lastRunAt: now } })
        .catch(sansBloquer("scheduler-runner.runScheduledWorkflows.scheduledWorkflow"));

      if (status === "FAILED") out.failed += 1;
      else if (status === "SKIPPED") out.skipped += 1;
      else out.ran += 1;
    }

    if (out.ran || out.failed || out.released) {
      console.info("[scheduler] sweep", JSON.stringify(out));
    }
  } catch (err) {
    console.error("[scheduler] sweep failed", err);
  }
  return out;
}

interface ClaimedWorkflow {
  id: string;
  kind: string;
  ownerId: string;
  payload: unknown;
}

/**
 * PREND UNE PLANIFICATION DUE. Rend `null` quand il n'y en a pas — ce qui est le cas normal.
 *
 * On lit quelques candidates puis on tente de les prendre une par une : entre la lecture et la
 * prise, une autre instance a pu passer devant. C'est attendu, et c'est pour cela que la boucle
 * essaie la suivante au lieu d'abandonner.
 */
async function claimDue(now: Date): Promise<ClaimedWorkflow | null> {
  const candidates = await prisma.scheduledWorkflow.findMany({
    where: { status: "ACTIVE", claimedAt: null, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 5,
    select: { id: true, kind: true, ownerId: true, payload: true, recurrence: true, hourLocal: true, dayOfWeek: true, dayOfMonth: true },
  }).catch(sansBloquer("scheduler-runner.claimDue.scheduledWorkflow", []));

  for (const c of candidates) {
    // L'ÉCHÉANCE SUIVANTE EST CALCULÉE MAINTENANT, dans la même écriture que la prise. Un
    // processus tué juste après ne laisse donc pas une planification perpétuellement due.
    const next = nextRunAt(
      {
        recurrence: c.recurrence as Recurrence,
        hourLocal: c.hourLocal,
        dayOfWeek: c.dayOfWeek,
        dayOfMonth: c.dayOfMonth,
      },
      now,
    );

    const claimed = await prisma.scheduledWorkflow.updateMany({
      // La précondition `claimedAt: null` EST le verrou : la base arbitre, pas nous.
      where: { id: c.id, claimedAt: null, status: "ACTIVE" },
      data: { claimedAt: now, nextRunAt: next },
    }).catch(sansBloquer("scheduler-runner.claimDue.scheduledWorkflow", { count: 0 }));

    if (claimed.count === 1) return { id: c.id, kind: c.kind, ownerId: c.ownerId, payload: c.payload };
  }
  return null;
}

/** Les prises abandonnées par un processus tué reviennent au pot commun. */
async function releaseStale(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const r = await prisma.scheduledWorkflow
    .updateMany({ where: { claimedAt: { lt: cutoff } }, data: { claimedAt: null } })
    .catch(sansBloquer("scheduler-runner.releaseStale.scheduledWorkflow", { count: 0 }));
  if (r.count) console.warn("[scheduler] released stale claims", r.count);
  return r.count;
}

/**
 * CONSIGNE LE PASSAGE, puis élague. L'élagage se fait ICI et non dans un balayage séparé : une
 * planification horaire produirait sinon des milliers de lignes entre deux nettoyages.
 */
async function recordRun(
  workflowId: string,
  r: { status: RunStatus; summary: string | null; error: string | null; ms: number; startedAt: Date },
): Promise<void> {
  try {
    await prisma.workflowRun.create({
      data: {
        workflowId,
        startedAt: r.startedAt,
        finishedAt: new Date(),
        status: r.status,
        summary: r.summary?.slice(0, 2_000) ?? null,
        error: r.error?.slice(0, 1_000) ?? null,
        ms: r.ms,
      },
    });

    const old = await prisma.workflowRun.findMany({
      where: { workflowId },
      orderBy: { startedAt: "desc" },
      skip: RUN_HISTORY_KEEP,
      select: { id: true },
    });
    if (old.length) {
      await prisma.workflowRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    }
  } catch (err) {
    // Un historique qu'on ne sait pas écrire ne doit pas empêcher le traitement d'avoir eu lieu.
    console.error("[scheduler] recordRun failed", workflowId, err);
  }
}
