"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { rolesWithModule } from "@/lib/rbac";
import { peutEchangerSurConge } from "@/lib/entity-access";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { LIEN_MES_CONGES, LIEN_CONGES_A_SIGNER, LIEN_CONGES_A_TRANCHER_RH } from "@/lib/chemins/rh";
import { sansBloquer } from "@/lib/journal";

/**
 * ÉCRIRE DANS LA DISCUSSION D'UN CONGÉ (Direction, 07/10 : « ajoute une possibilité de discussion dans les congés »).
 *
 * Le modèle `Comment` canonique (entité `LEAVE_REQUEST`), le composant `CommentThread` — pas un second fil. La porte est
 * PAR DEMANDE (`peutEchangerSurConge`) : le salarié, son N+1 et la chaîne d'escalade, les RH qui tranchent. Modifier ou
 * retirer un message passe par les actions canoniques (`comment-actions.ts`).
 *
 * On prévient l'autre côté : le salarié quand quelqu'un lui écrit ; quand c'est lui qui écrit, celui qui tient la marche.
 */
export async function commenterConge(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const leaveId = fdStr(formData, "leaveId");
  const body = fdStr(formData, "body");
  if (!leaveId) return { ok: false, error: "Demande de congé introuvable." };
  if (!body) return { ok: false, error: "Le message est vide." };
  if (!(await peutEchangerSurConge(user, leaveId))) return { ok: false, error: "Cette demande ne vous est pas ouverte." };

  const conge = await prisma.leaveRequest.findUnique({
    where: { id: leaveId },
    select: {
      stage: true, status: true, managerId: true, currentApproverId: true,
      employee: { select: { fullName: true, userId: true } },
    },
  });
  if (!conge) return { ok: false, error: "Demande de congé introuvable." };

  await prisma.comment.create({ data: { entityType: "LEAVE_REQUEST", entityId: leaveId, body: body.slice(0, 5000), authorId: user.id } });

  const extrait = body.length > 160 ? `${body.slice(0, 157)}…` : body;
  if (conge.employee.userId && conge.employee.userId !== user.id) {
    await notifyUser({
      userId: conge.employee.userId, type: "GENERIC", title: "Message sur votre demande de congé",
      body: `${user.name} : ${extrait}`, link: LIEN_MES_CONGES,
    }).catch(sansBloquer("conge-discussion-actions.commenterConge.notifyUser"));
  } else if (conge.status === "PENDING") {
    // Le salarié écrit : celui qui tient la marche le lit.
    if (conge.stage === "MANAGER") {
      const n1 = conge.currentApproverId
        ?? (conge.managerId ? (await prisma.employee.findUnique({ where: { id: conge.managerId }, select: { userId: true } }))?.userId ?? null : null);
      if (n1 && n1 !== user.id) {
        await notifyUser({
          userId: n1, type: "GENERIC", title: "Message sur un congé à signer",
          body: `${conge.employee.fullName} : ${extrait}`, link: LIEN_CONGES_A_SIGNER,
        }).catch(sansBloquer("conge-discussion-actions.commenterConge.notifyUser"));
      }
    } else if (conge.stage === "HR") {
      await notifyRoles(rolesWithModule("HR_REQUESTS", "VALIDATE"), {
        type: "GENERIC", title: "Message sur un congé à trancher",
        body: `${conge.employee.fullName} : ${extrait}`, link: LIEN_CONGES_A_TRANCHER_RH,
      }).catch(sansBloquer("conge-discussion-actions.commenterConge.notifyRoles"));
    }
  }

  revalidatePath("/rh/demandes");
  revalidatePath("/mon-espace");
  revalidatePath("/mon-dossier");
  return { ok: true };
}
