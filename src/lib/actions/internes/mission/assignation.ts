/**
 * MISSIONS AD & PRO — l'ASSIGNATION lue par les actions : la charger, ce qui interdit de l'effacer, le dernier
 * ordre de mission, la porte « ma mission confirmée », et les pages à rafraîchir.
 *
 * Sorti de `actions/mission-actions.ts` (lot V4) : lectures seulement — les écrivains (`inviter`, `retirer`)
 * restent dans le fichier d'actions.
 */
import { revalidatePath } from "next/cache";
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MES_MISSIONS, parentPath } from "@/lib/missions-equipe/serveur";

export function revalider(entityType: EntityType, entityId: string): void {
  revalidatePath(parentPath(entityType, entityId));
  revalidatePath(MES_MISSIONS);
  revalidatePath(`${MES_MISSIONS}/[id]`, "page");
  revalidatePath("/missions");
}

export const dates = (d: Date | null, f: Date | null) =>
  d ? ` · ${d.toLocaleDateString("fr-FR")}${f && f.getTime() !== d.getTime() ? ` → ${f.toLocaleDateString("fr-FR")}` : ""}` : "";

export async function chargerAssignation(id: string | null) {
  if (!id) return null;
  return prisma.missionAssignment.findUnique({ where: { id } });
}

/** Les traces qui interdisent l'effacement : pièces, fil, demandes reliées. */
export async function tracesDe(id: string) {
  const [documents, commentaires, rh, secretariat, materiel, versions, frais] = await Promise.all([
    prisma.document.count({ where: { entityType: "MISSION_ASSIGNMENT", entityId: id } }),
    prisma.comment.count({ where: { entityType: "MISSION_ASSIGNMENT", entityId: id } }),
    prisma.hrDocumentRequest.count({ where: { missionAssignmentId: id } }),
    prisma.administrativeRequest.count({ where: { linkedEntityType: "MISSION_ASSIGNMENT", linkedEntityId: id } }),
    prisma.promoStockRequest.count({ where: { missionAssignmentId: id } }),
    // Une fiche envoyée ou une dépense saisie est une trace : la négociation et les frais restent, archivés.
    prisma.missionParticipationVersion.count({ where: { assignmentId: id } }),
    prisma.missionExpenseLine.count({ where: { assignmentId: id } }),
  ]);
  return { documents, commentaires, demandes: rh + secretariat + materiel + versions + frais };
}

export async function dernierOrdre(assignmentId: string) {
  return prisma.hrDocumentRequest.findFirst({
    where: { missionAssignmentId: assignmentId, type: "MISSION_ORDER" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, managerGate: true, managerUserId: true },
  });
}

/** Une mission confirmée, la sienne, active — la porte de toutes les étapes. */
export async function maMissionConfirmee(id: string | null, userId: string) {
  const a = await chargerAssignation(id);
  if (!a || a.archivedAt) return { erreur: "Mission introuvable." } as const;
  if (a.userId !== userId) return { erreur: "Seule la personne en mission fait ses demandes." } as const;
  if (a.response !== "CONFIRMEE") return { erreur: "Confirmez d'abord la mission." } as const;
  return { a } as const;
}
