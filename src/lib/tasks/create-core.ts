import type { Priority, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { taskCreationMode, creationNotices, CREATION_STATUS, type TaskCreationMode } from "@/lib/tasks/request-flow";
import { rejouerNotifications } from "@/lib/notifications/ecrire";
import { admettreLignes } from "@/lib/notifications/admission";
import { lienTache } from "@/lib/chemins/espace";

/**
 * LE CŒUR canonique de la création de tâche — partagé par l'écran ET le Chief of Staff.
 *
 * Les RÈGLES du circuit (« pour soi une to-do, pour un autre une DEMANDE qui s'accepte ou se
 * refuse ») vivent dans `request-flow.ts` (pur) ; ici vit leur APPLICATION : la ligne créée
 * avec le bon statut et `requestedAt`, les notifications (pop-up pour le destinataire d'une
 * demande, cloche pour les autres), l'audit. L'action serveur (`task-actions.ts`) garde ce qui
 * n'appartient qu'au formulaire (session, pièces jointes, revalidation) ; l'assistant appelle
 * ce cœur avec l'utilisateur déjà authentifié — jamais une deuxième logique du circuit.
 */
export interface CreateTaskInput {
  title: string;
  description?: string | null;
  assignedToId: string;
  participantIds?: string[];
  readerIds?: string[];
  dueDate?: Date | null;
  priority?: Priority | null;
  module?: string | null;
  address?: string | null;
  expectedMinutes?: number | null;
}

export async function createTaskRecord(
  actorId: string,
  input: CreateTaskInput,
  audit?: { module?: string; suffix?: string },
): Promise<{ id: string; mode: TaskCreationMode }> {
  const mode = taskCreationMode(input.assignedToId, actorId);
  const participantIds = input.participantIds ?? [];
  const readerIds = input.readerIds ?? [];

  const created = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      assignedToId: input.assignedToId,
      participantIds,
      readerIds,
      createdById: actorId,
      status: CREATION_STATUS[mode] as TaskStatus,
      // `requestedAt` MARQUE LE PARCOURS : c'est lui, et non le statut du moment, qui dit qu'une
      // tâche est née d'une demande — une fois acceptée, elle n'aura pas d'étape intermédiaire.
      requestedAt: mode === "request" ? new Date() : null,
      dueDate: input.dueDate ?? null,
      priority: input.priority ?? "MEDIUM",
      module: input.module ?? null,
      address: input.address ?? null,
      expectedMinutes: input.expectedMinutes ?? null,
    },
    select: { id: true },
  });

  // Prévenir chacun selon son rôle : le destinataire d'une DEMANDE reçoit une pop-up (elle
  // attend sa réponse), les participants et lecteurs la cloche.
  const notices = creationNotices({ creatorId: actorId, assignedToId: input.assignedToId, participantIds, readerIds, mode });
  if (notices.length) {
    // La tâche s'ouvre dans la vue où elle se range POUR CHACUN : « À faire » (ou « à accepter ») pour qui
    // la reçoit, « Partagées » pour un participant ou un lecteur.
    const lignes = await admettreLignes(notices.map((n) => ({
      userId: n.userId, type: "ASSIGNMENT" as const, title: n.title, body: input.title,
      link: lienTache(created.id, n.userId === input.assignedToId ? undefined : "partagees"), popup: n.popup,
    })), "nominatif", "tasks.createTaskCore");
    if (lignes.length) try {
      await prisma.notification.createMany({ data: lignes });
    } catch (err) {
      await rejouerNotifications(lignes, err);
    }
  }

  await recordAudit({
    actorId, action: "CREATE", module: audit?.module ?? "Espace de travail",
    entityType: "TASK", entityId: created.id,
    summary: `${mode === "request" ? "Demande de tâche" : "Tâche"} « ${input.title} »${audit?.suffix ?? ""}`,
  });
  return { id: created.id, mode };
}
