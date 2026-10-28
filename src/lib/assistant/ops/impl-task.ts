import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { TASK_STATUS } from "@/lib/labels";
import {
  respondTaskRequest, submitTaskWork, reopenTaskWork, addTaskComment, deleteTask,
} from "@/lib/actions/task-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";

/**
 * OPS TÂCHES — le côté « MOI » du circuit de demande : répondre (accepter/refuser), faire
 * (valider son travail, rouvrir) et échanger (commenter). La création vit déjà dans
 * `create_task` ; ici on ferme l'autre moitié — celle où le Chief agit au nom de la personne
 * connectée SUR SES PROPRES tâches, par les ACTIONS CANONIQUES de `task-actions.ts`
 * (mêmes règles `canRespond`/`canDoWork`/`canComment`, mêmes notifications, même audit).
 *
 * La résolution ne montre QUE les tâches où l'op est réellement possible pour la personne :
 * proposer d'accepter une tâche déjà acceptée, ou celle d'un collègue, serait un mensonge.
 */

interface TaskHit { id: string; title: string; status: string; from: string }

function statusLabel(status: string): string {
  return TASK_STATUS[status]?.label ?? status;
}

async function resolveMyTask(
  user: CurrentUser,
  raw: string,
  mode: "respond" | "work" | "reopen" | "comment" | "delete",
): Promise<TaskHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez l'intitulé (ou un morceau) de la tâche visée (champ « title »)." };
  // Le filtre REPREND les règles pures de `request-flow` (canRespond/canDoWork/canComment),
  // traduites en clause de recherche — l'action canonique les revérifie de toute façon.
  const doers: Prisma.TaskWhereInput[] = [{ assignedToId: user.id }, { participantIds: { has: user.id } }];
  const circle: Prisma.TaskWhereInput[] = [...doers, { createdById: user.id }, { readerIds: { has: user.id } }];
  const scope: Prisma.TaskWhereInput =
    mode === "respond"
      ? { assignedToId: user.id, status: "REQUESTED" }
      : mode === "work"
        ? { OR: doers, status: { notIn: ["REQUESTED", "DECLINED", "CANCELLED"] } }
        : mode === "reopen"
          ? { OR: doers, status: "DONE" }
          : mode === "delete"
            // Supprimer = retirer SA saisie : le créateur seulement (l'admin, lui, voit tout).
            ? (user.role === "SUPER_ADMIN" ? {} : { createdById: user.id })
            : hasGlobalView(user.role)
              ? {}
              : { OR: circle };
  const rows = await prisma.task.findMany({
    where: { AND: [{ title: { contains: q, mode: "insensitive" } }, scope] },
    select: { id: true, title: true, status: true, createdBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const hits: TaskHit[] = rows.map((r) => ({
    id: r.id, title: r.title, status: r.status, from: r.createdBy?.name ?? "—",
  }));
  if (hits.length === 0) {
    const what =
      mode === "respond" ? "demande de tâche EN ATTENTE de votre réponse"
        : mode === "reopen" ? "tâche TERMINÉE dont vous avez fait le travail"
          : mode === "work" ? "tâche en cours dont vous faites le travail"
            : mode === "delete" ? "tâche créée par vous (une tâche reçue se REFUSE, elle ne se supprime pas)"
              : "tâche de votre cercle";
    return { error: `Aucune ${what} ne correspond à « ${q} ». (list_my_tasks montre vos tâches.)` };
  }
  const exact = hits.filter((h) => h.title.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return {
    error: `Plusieurs tâches correspondent à « ${q} » : ${hits.map((h) => `« ${h.title} » (${statusLabel(h.status)}, demandée par ${h.from})`).join(" ; ")} — préciser l'intitulé exact.`,
  };
}

const taskFields = (t: TaskHit): { label: string; value: string }[] => [
  { label: "Tâche", value: t.title },
  { label: "Demandée par", value: t.from },
  { label: "Statut actuel", value: statusLabel(t.status) },
];

const taskLink = (id: string): string => `/mon-espace/taches/${id}`;
const TASK_REVALIDATE = ["/mon-espace"];

export const TASK_OPS_IMPL: Record<string, OpImpl> = {
  delete_task: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const t = await resolveMyTask(user, opStr(input, "title"), "delete");
      if ("error" in t) return t;
      return {
        title: `Supprimer la tâche « ${t.title} »`,
        fields: taskFields(t),
        warnings: ["Suppression définitive — les pièces jointes et le fil de la tâche partent avec elle."],
        args: { id: t.id, title: t.title },
        successMessage: `Tâche « ${t.title} » supprimée.`,
        link: "/mon-espace",
        revalidate: TASK_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await deleteTask(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La suppression a été refusée." };
      return { ok: true, revalidate: TASK_REVALIDATE };
    },
  },

  accept: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const t = await resolveMyTask(user, opStr(input, "title"), "respond");
      if ("error" in t) return t;
      return {
        title: `Accepter la demande de tâche « ${t.title} »`,
        fields: taskFields(t),
        warnings: ["Accepter, c'est commencer : la tâche passe En cours et le demandeur est notifié."],
        args: { id: t.id, title: t.title },
        successMessage: `Demande « ${t.title} » acceptée — la tâche est En cours, le demandeur est prévenu.`,
        link: taskLink(t.id),
        revalidate: TASK_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("accept", "1");
      const r = await respondTaskRequest(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'acceptation a été refusée." };
      return { ok: true, revalidate: TASK_REVALIDATE };
    },
  },

  refuse: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const t = await resolveMyTask(user, opStr(input, "title"), "respond");
      if ("error" in t) return t;
      const reason = opStr(input, "reason");
      return {
        title: `Refuser la demande de tâche « ${t.title} »`,
        fields: [
          ...taskFields(t),
          { label: "Motif", value: reason || "(aucun — le motif est facultatif)" },
        ],
        warnings: ["Le demandeur est notifié du refus, avec le motif s'il y en a un."],
        args: { id: t.id, title: t.title, reason: reason || null },
        successMessage: `Demande « ${t.title} » refusée — le demandeur est prévenu.`,
        link: taskLink(t.id),
        revalidate: TASK_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("accept", "0");
      if (args.reason) fd.set("reason", args.reason);
      const r = await respondTaskRequest(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le refus a été refusé." };
      return { ok: true, revalidate: TASK_REVALIDATE };
    },
  },

  submit_work: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const t = await resolveMyTask(user, opStr(input, "title"), "work");
      if ("error" in t) return t;
      const note = opStr(input, "note");
      const again = t.status === "DONE";
      return {
        title: again ? `Mettre à jour mon travail sur « ${t.title} »` : `Valider mon travail sur « ${t.title} »`,
        fields: [
          ...taskFields(t),
          { label: "Compte rendu", value: note || "(aucun)" },
        ],
        warnings: ["La tâche passe TERMINÉE et le demandeur est notifié — le compte rendu reste modifiable ensuite."],
        args: { id: t.id, title: t.title, note: note || null },
        successMessage: again ? `Travail mis à jour sur « ${t.title} ».` : `Travail validé sur « ${t.title} » — le demandeur est prévenu.`,
        link: taskLink(t.id),
        revalidate: TASK_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.note) fd.set("note", args.note);
      const r = await submitTaskWork(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La validation du travail a été refusée." };
      return { ok: true, revalidate: TASK_REVALIDATE };
    },
  },

  reopen: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const t = await resolveMyTask(user, opStr(input, "title"), "reopen");
      if ("error" in t) return t;
      return {
        title: `Rouvrir la tâche « ${t.title} »`,
        fields: taskFields(t),
        warnings: ["La tâche repasse En cours — la validation n'est pas une porte qui claque."],
        args: { id: t.id, title: t.title },
        successMessage: `Tâche « ${t.title} » rouverte (En cours).`,
        link: taskLink(t.id),
        revalidate: TASK_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await reopenTaskWork(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La réouverture a été refusée." };
      return { ok: true, revalidate: TASK_REVALIDATE };
    },
  },

  comment: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const body = opStr(input, "comment");
      if (!body) return { error: "Donnez le message à poster (champ « comment »)." };
      const t = await resolveMyTask(user, opStr(input, "title"), "comment");
      if ("error" in t) return t;
      return {
        title: `Commenter la tâche « ${t.title} »`,
        fields: [
          ...taskFields(t),
          { label: "Message", value: body.slice(0, 300) },
        ],
        warnings: ["Le fil ne se modifie ni ne s'efface — le cercle de la tâche est prévenu (cloche)."],
        args: { id: t.id, title: t.title, body: body.slice(0, 4000) },
        successMessage: `Message posté sur « ${t.title} » — le cercle de la tâche est prévenu.`,
        link: taskLink(t.id),
        revalidate: TASK_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("body", args.body ?? "");
      const r = await addTaskComment(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le commentaire a été refusé." };
      return { ok: true, revalidate: TASK_REVALIDATE };
    },
  },
};
