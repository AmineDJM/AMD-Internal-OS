import { prisma } from "@/lib/prisma";
import {
  type Recurrence,
  type Schedule,
  type WorkflowStatus,
  RECURRENCES,
  describeSchedule,
  nextRunAt,
} from "./contract";
import { isKnownWorkflow, availableWorkflows } from "./registry";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * GÉRER SES PLANIFICATIONS (§9) — créer, mettre en pause, modifier, supprimer, consulter.
 *
 * ── LES GARDES, ET POURQUOI CHACUNE EXISTE ───────────────────────────────────────────────
 *
 *   • **La clé doit être au registre.** Une planification ne porte pas de code ; elle désigne un
 *     traitement déclaré. Refuser ici évite qu'une clé inventée dorme en base jusqu'au jour où un
 *     registre plus permissif la rendrait exécutable.
 *   • **On ne gère que SES planifications.** Chaque appel exige l'identité de l'appelant et la
 *     compare au propriétaire. La propriété n'est pas qu'un affichage : c'est le PÉRIMÈTRE DE
 *     LECTURE du traitement — modifier la planification de quelqu'un d'autre reviendrait à faire
 *     tourner un rapport avec ses droits à lui.
 *   • **La suppression est une vraie suppression**, avec son historique (cascade). Une
 *     planification « supprimée » qui continuerait de tourner serait le pire des cas.
 *
 * Toutes ces fonctions rendent un résultat NOMMÉ plutôt que de lever : l'appelant est une action
 * serveur ou un outil, et il doit pouvoir expliquer le refus à quelqu'un.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ManageResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export interface CreateWorkflowInput {
  name: string;
  kind: string;
  recurrence: string;
  hourLocal?: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  payload?: Record<string, unknown>;
  /** Au nom de qui la planification s'exécute. Par défaut : l'appelant. */
  ownerId?: string;
}

export interface WorkflowView {
  id: string;
  name: string;
  kind: string;
  /** Le libellé du traitement, ou la clé si le traitement a disparu du registre — jamais un vide. */
  kindLabel: string;
  schedule: string;
  status: WorkflowStatus;
  nextRunAt: Date;
  lastRunAt: Date | null;
  /** L'issue des derniers passages, la plus récente d'abord. */
  recentRuns: { at: Date; status: string; summary: string | null; error: string | null; ms: number | null }[];
  /** Le traitement existe-t-il encore ? Une planification orpheline se voit au lieu de se taire. */
  orphaned: boolean;
}

/**
 * CRÉE UNE PLANIFICATION.
 *
 * La première échéance est calculée à la création, pas au premier passage : l'utilisateur doit
 * voir « prochaine exécution : dimanche 7 h » immédiatement, sinon il ne peut pas vérifier qu'il
 * a bien compris ce qu'il vient de programmer.
 */
export async function createWorkflow(input: CreateWorkflowInput, actorId: string): Promise<ManageResult<WorkflowView>> {
  const name = input.name.trim();
  if (name.length < 3) return fail("Donnez un nom à la planification (au moins 3 caractères).");
  if (!isKnownWorkflow(input.kind)) {
    const known = availableWorkflows().map((w) => w.kind).join(", ");
    return fail(`Traitement inconnu : « ${input.kind} ». Disponibles : ${known || "aucun"}.`);
  }
  if (!RECURRENCES.includes(input.recurrence as Recurrence)) {
    return fail(`Récurrence inconnue : « ${input.recurrence} ». Attendu : ${RECURRENCES.join(", ")}.`);
  }

  const schedule: Schedule = {
    recurrence: input.recurrence as Recurrence,
    hourLocal: input.hourLocal ?? 7,
    dayOfWeek: input.dayOfWeek ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
  };

  // Le propriétaire par défaut est l'appelant. En désigner un autre revient à faire tourner un
  // traitement avec les droits de lecture de cette personne : réservé à l'administration, et
  // c'est à l'appelant (action serveur) de l'avoir vérifié avant d'arriver ici.
  const ownerId = input.ownerId ?? actorId;

  try {
    const wf = await prisma.scheduledWorkflow.create({
      data: {
        name, kind: input.kind,
        recurrence: schedule.recurrence,
        hourLocal: schedule.hourLocal,
        dayOfWeek: schedule.dayOfWeek,
        dayOfMonth: schedule.dayOfMonth,
        payload: (input.payload ?? undefined) as object | undefined,
        nextRunAt: nextRunAt(schedule, new Date()),
        ownerId,
        createdById: actorId,
      },
      select: SELECT_WF,
    });
    return { ok: true, value: toView(wf, []) };
  } catch (err) {
    console.error("[scheduler] createWorkflow failed", err);
    return fail("La planification n'a pas pu être enregistrée.");
  }
}

/** MET EN PAUSE ou REPREND. Une pause conserve l'historique ET la prochaine échéance. */
export async function setWorkflowStatus(
  id: string,
  status: WorkflowStatus,
  actorId: string,
): Promise<ManageResult<WorkflowView>> {
  const owned = await assertOwned(id, actorId);
  if (!owned.ok) return owned;

  // À la REPRISE, l'échéance est recalculée depuis maintenant. Sans cela, une planification en
  // pause depuis trois semaines serait immédiatement due et tournerait aussitôt — ce que personne
  // n'attend en cliquant « reprendre ».
  const data = status === "ACTIVE"
    ? { status, nextRunAt: nextRunAt(scheduleOf(owned.value), new Date()), claimedAt: null }
    : { status };

  const wf = await prisma.scheduledWorkflow.update({ where: { id }, data, select: SELECT_WF }).catch(sansBloquer("scheduler-manage.setWorkflowStatus.scheduledWorkflow", null));
  if (!wf) return fail("La planification n'a pas pu être mise à jour.");
  return { ok: true, value: toView(wf, await recentRuns(id)) };
}

export interface UpdateWorkflowInput {
  name?: string;
  recurrence?: string;
  hourLocal?: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  payload?: Record<string, unknown>;
}

/** MODIFIE. Toute retouche de la cadence recalcule l'échéance — sinon l'affichage mentirait. */
export async function updateWorkflow(
  id: string,
  input: UpdateWorkflowInput,
  actorId: string,
): Promise<ManageResult<WorkflowView>> {
  const owned = await assertOwned(id, actorId);
  if (!owned.ok) return owned;

  if (input.recurrence && !RECURRENCES.includes(input.recurrence as Recurrence)) {
    return fail(`Récurrence inconnue : « ${input.recurrence} ».`);
  }

  const schedule: Schedule = {
    recurrence: (input.recurrence as Recurrence) ?? (owned.value.recurrence as Recurrence),
    hourLocal: input.hourLocal ?? owned.value.hourLocal,
    dayOfWeek: input.dayOfWeek !== undefined ? input.dayOfWeek : owned.value.dayOfWeek,
    dayOfMonth: input.dayOfMonth !== undefined ? input.dayOfMonth : owned.value.dayOfMonth,
  };
  const cadenceChanged =
    schedule.recurrence !== owned.value.recurrence ||
    schedule.hourLocal !== owned.value.hourLocal ||
    schedule.dayOfWeek !== owned.value.dayOfWeek ||
    schedule.dayOfMonth !== owned.value.dayOfMonth;

  const wf = await prisma.scheduledWorkflow.update({
    where: { id },
    data: {
      ...(input.name ? { name: input.name.trim() } : {}),
      recurrence: schedule.recurrence,
      hourLocal: schedule.hourLocal,
      dayOfWeek: schedule.dayOfWeek,
      dayOfMonth: schedule.dayOfMonth,
      ...(input.payload ? { payload: input.payload as object } : {}),
      ...(cadenceChanged ? { nextRunAt: nextRunAt(schedule, new Date()) } : {}),
    },
    select: SELECT_WF,
  }).catch(sansBloquer("scheduler-manage.updateWorkflow.scheduledWorkflow", null));
  if (!wf) return fail("La planification n'a pas pu être mise à jour.");
  return { ok: true, value: toView(wf, await recentRuns(id)) };
}

/** SUPPRIME — définitivement, avec son historique. Une planification fantôme serait pire. */
export async function deleteWorkflow(id: string, actorId: string): Promise<ManageResult<{ id: string }>> {
  const owned = await assertOwned(id, actorId);
  if (!owned.ok) return owned;
  const done = await prisma.scheduledWorkflow.delete({ where: { id } }).catch(sansBloquer("scheduler-manage.deleteWorkflow.scheduledWorkflow", null));
  if (!done) return fail("La planification n'a pas pu être supprimée.");
  return { ok: true, value: { id } };
}

/** LES PLANIFICATIONS D'UNE PERSONNE, avec leur historique récent. */
export async function listWorkflows(ownerId: string, limit = 50): Promise<WorkflowView[]> {
  const rows = await prisma.scheduledWorkflow.findMany({
    where: { ownerId },
    orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
    take: limit,
    select: { ...SELECT_WF, runs: { orderBy: { startedAt: "desc" }, take: 5, select: RUN_SELECT } },
  }).catch(sansBloquer("scheduler-manage.listWorkflows.scheduledWorkflow", []));

  return rows.map((r) => toView(r, r.runs));
}

// ─────────────────────────────────── Le détail ───────────────────────────────────

const SELECT_WF = {
  id: true, name: true, kind: true, recurrence: true, hourLocal: true,
  dayOfWeek: true, dayOfMonth: true, status: true, nextRunAt: true, lastRunAt: true,
  ownerId: true,
} as const;

const RUN_SELECT = { startedAt: true, status: true, summary: true, error: true, ms: true } as const;

type WfRow = {
  id: string; name: string; kind: string; recurrence: string; hourLocal: number;
  dayOfWeek: number | null; dayOfMonth: number | null; status: string;
  nextRunAt: Date; lastRunAt: Date | null; ownerId: string;
};

type RunRow = { startedAt: Date; status: string; summary: string | null; error: string | null; ms: number | null };

const scheduleOf = (w: WfRow): Schedule => ({
  recurrence: w.recurrence as Recurrence,
  hourLocal: w.hourLocal,
  dayOfWeek: w.dayOfWeek,
  dayOfMonth: w.dayOfMonth,
});

function toView(w: WfRow, runs: RunRow[]): WorkflowView {
  const known = availableWorkflows().find((h) => h.kind === w.kind);
  return {
    id: w.id,
    name: w.name,
    kind: w.kind,
    // Une planification dont le traitement a disparu garde sa clé lisible ET porte un drapeau :
    // l'afficher comme normale ferait attendre un rapport qui ne viendra jamais.
    kindLabel: known?.label ?? w.kind,
    orphaned: !known,
    schedule: describeSchedule(scheduleOf(w)),
    status: w.status as WorkflowStatus,
    nextRunAt: w.nextRunAt,
    lastRunAt: w.lastRunAt,
    recentRuns: runs.map((r) => ({ at: r.startedAt, status: r.status, summary: r.summary, error: r.error, ms: r.ms })),
  };
}

async function recentRuns(workflowId: string): Promise<RunRow[]> {
  return prisma.workflowRun
    .findMany({ where: { workflowId }, orderBy: { startedAt: "desc" }, take: 5, select: RUN_SELECT })
    .catch(sansBloquer("scheduler-manage.recentRuns.workflowRun", []));
}

/**
 * LA GARDE DE PROPRIÉTÉ. Le même message pour « introuvable » et « pas à vous » : distinguer les
 * deux dirait à un curieux qu'une planification existe, ce qu'il n'a pas à savoir.
 */
async function assertOwned(id: string, actorId: string): Promise<ManageResult<WfRow>> {
  const wf = await prisma.scheduledWorkflow.findUnique({ where: { id }, select: SELECT_WF }).catch(sansBloquer("scheduler-manage.assertOwned.scheduledWorkflow", null));
  if (!wf || wf.ownerId !== actorId) return fail("Planification introuvable.");
  return { ok: true, value: wf };
}
