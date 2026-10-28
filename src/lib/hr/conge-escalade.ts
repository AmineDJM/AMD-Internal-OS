import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { getManagerOfUser } from "@/lib/departments";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import type { SessionUser } from "@/lib/rbac";
import { leaveDecider } from "@/lib/hr/leave-core";
import { LIEN_CONGES_A_SIGNER } from "@/lib/chemins/rh";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDER À SON N+1 — la marche du responsable qui REMONTE, puis REDESCEND (Direction, 06/10).
 *
 * « Un arrêt maladie, une demande de congé, exceptionnel ou pas, arrive chez le N+1 d'abord, dans Mon Équipe, avec une
 * notification ; une fois validé, ça va chez les RH. Avec une possibilité au N+1 de demander aussi à SON N+1 : ça
 * remonte au N+1, puis ça peut encore remonter, jusqu'au max ; ensuite les validations redescendent, et sont tracées. »
 *
 *   • REMONTER (`remonterConge`) : celui qui tient la marche demande l'avis de son propre N+1 — une ligne
 *     `LeaveEscalation` (de qui, à qui, pourquoi), et la marche passe à ce N+1 (`currentApproverId`). Il peut remonter
 *     à son tour : chaque échelon est une ligne de plus.
 *   • REDESCENDRE (`trancherSousEscalade`) : le N+1 sollicité VALIDE → sa ligne est close « validé », et la demande
 *     REDESCEND chez celui qui l'avait sollicité, prévenu ; qui valide à son tour, et ainsi de suite jusqu'au N+1 de la
 *     demande, dont la validation l'envoie aux RH. Un REFUS, à quelque échelon que ce soit, arrête la demande : toutes
 *     les lignes ouvertes se ferment « refusé », et chacun en dessous est prévenu.
 *   • Tant qu'un avis est attendu au-dessus, celui qui l'a demandé ne tranche pas (la Direction le peut toujours).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LigneEscalade { id: string; order: number; fromUserId: string; toUserId: string; decision: string | null }

/** L'avis attendu en ce moment : la ligne ouverte la plus haute. */
export async function escaladeOuverte(leaveId: string): Promise<LigneEscalade | null> {
  return prisma.leaveEscalation.findFirst({
    where: { leaveId, decision: null }, orderBy: { order: "desc" },
    select: { id: true, order: true, fromUserId: true, toUserId: true, decision: true },
  });
}

const nomDe = async (userId: string): Promise<string> => (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "—";

/** REMONTER la marche du responsable chez SON N+1. */
export async function remonterConge(user: SessionUser, leaveId: string, note: string | null): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const leave = await prisma.leaveRequest.findUnique({
    where: { id: leaveId },
    select: { id: true, status: true, stage: true, managerId: true, employeeId: true, currentApproverId: true, startDate: true, endDate: true, employee: { select: { fullName: true, userId: true } } },
  });
  if (!leave) return { ok: false, error: "Demande introuvable." };
  if (leave.status !== "PENDING" || leave.stage !== "MANAGER") return { ok: false, error: "Seule une demande à la marche du responsable peut remonter." };
  const { ids } = await auNomDeQui(user.id);
  // QUI TIENT LA MARCHE : celui à qui elle a été remontée ; sinon le responsable de la demande (ou la chaîne actuelle).
  if (leave.currentApproverId) {
    if (!ids.has(leave.currentApproverId)) return { ok: false, error: `Cette demande attend l'avis de ${await nomDe(leave.currentApproverId)}.` };
  } else {
    if (!(await leaveDecider(user, leave)).isManager) return { ok: false, error: "Seul le responsable de la demande peut demander l'avis de son N+1." };
  }
  const titulaire = leave.currentApproverId ?? user.id;
  const n1 = await getManagerOfUser(titulaire);
  if (!n1?.userId) return { ok: false, error: "Aucun N+1 au-dessus de vous dans l'organigramme : c'est à vous de trancher." };
  if (n1.userId === leave.employee.userId) return { ok: false, error: "Votre N+1 est la personne qui demande ce congé : tranchez, ou laissez les RH." };

  const derniere = await prisma.leaveEscalation.findFirst({ where: { leaveId }, orderBy: { order: "desc" }, select: { order: true } });
  const pose = await prisma.$transaction(async (tx) => {
    const r = await tx.leaveRequest.updateMany({
      where: { id: leaveId, status: "PENDING", stage: "MANAGER", currentApproverId: leave.currentApproverId },
      data: { currentApproverId: n1.userId },
    });
    if (r.count === 0) return false;
    await tx.leaveEscalation.create({ data: { leaveId, order: (derniere?.order ?? 0) + 1, fromUserId: titulaire, toUserId: n1.userId as string, note } });
    return true;
  });
  if (!pose) return { ok: false, error: "Cette demande vient de changer — rechargez la page." };

  const periode = `${leave.startDate.toLocaleDateString("fr-FR")} → ${leave.endDate.toLocaleDateString("fr-FR")}`;
  await notifyUser({
    userId: n1.userId, type: "GENERIC", title: "Avis demandé sur un congé",
    body: `${await nomDe(user.id)} vous demande de valider le congé de ${leave.employee.fullName} (${periode}).${note ? ` « ${note} »` : ""}`,
    link: LIEN_CONGES_A_SIGNER,
  }).catch(sansBloquer("conge-escalade.remonterConge.notifyUser"));
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Ressources humaines", entityType: "LEAVE_REQUEST", entityId: leaveId,
    summary: `Congé de ${leave.employee.fullName} remonté à ${n1.fullName ?? (await nomDe(n1.userId))} pour avis${note ? ` — « ${note} »` : ""}`,
  });
  return { ok: true, message: `Demande remontée à ${n1.fullName ?? "votre N+1"} : elle vous reviendra avec sa décision.` };
}

/**
 * TRANCHER SOUS UNE ESCALADE — `null` quand aucun avis n'est attendu (la décision suit le circuit ordinaire), sinon le
 * résultat. Un REFUS ferme les lignes ouvertes puis laisse le circuit ordinaire refuser la demande (`continuer: true`).
 */
export async function trancherSousEscalade(
  user: SessionUser, leaveId: string, decision: "APPROVED" | "REJECTED", note: string | null, isDg: boolean,
): Promise<null | { ok: false; error: string } | { ok: true; message: string } | { continuer: true }> {
  const ouverte = await escaladeOuverte(leaveId);
  const { ids } = await auNomDeQui(user.id);
  if (!ouverte) {
    // Plus rien n'attend au-dessus : celui qui tient (encore) la marche est le seul responsable à trancher.
    const l = await prisma.leaveRequest.findUnique({ where: { id: leaveId }, select: { currentApproverId: true } });
    if (l?.currentApproverId && !ids.has(l.currentApproverId) && !isDg) return { ok: false, error: `Cette demande est entre les mains de ${await nomDe(l.currentApproverId)}.` };
    return null;
  }
  if (!ids.has(ouverte.toUserId) && !isDg) {
    return { ok: false, error: `Cette demande attend l'avis de ${await nomDe(ouverte.toUserId)} — elle vous reviendra avec sa décision.` };
  }
  const maintenant = new Date();
  if (decision === "REJECTED") {
    // UN REFUS ARRÊTE TOUT : chaque échelon ouvert est fermé « refusé », et chacun en dessous le saura.
    const ouvertes = await prisma.leaveEscalation.findMany({ where: { leaveId, decision: null }, select: { fromUserId: true } });
    await prisma.leaveEscalation.updateMany({ where: { leaveId, decision: null }, data: { decision: "REJECTED", decisionNote: note, decidedAt: maintenant } });
    await prisma.leaveRequest.updateMany({ where: { id: leaveId }, data: { currentApproverId: null } });
    for (const o of ouvertes) {
      await notifyUser({ userId: o.fromUserId, type: "GENERIC", title: "Congé refusé plus haut", body: `${await nomDe(user.id)} a refusé la demande que vous lui aviez remontée.${note ? ` « ${note} »` : ""}`, link: "/mon-equipe" }).catch(sansBloquer("conge-escalade.trancherSousEscalade.notifyUser"));
    }
    return { continuer: true };
  }
  // VALIDÉ : la ligne se ferme, et la demande REDESCEND chez celui qui l'avait remontée.
  const r = await prisma.$transaction(async (tx) => {
    const close = await tx.leaveEscalation.updateMany({ where: { id: ouverte.id, decision: null }, data: { decision: "APPROVED", decisionNote: note, decidedAt: maintenant } });
    if (close.count === 0) return false;
    await tx.leaveRequest.updateMany({ where: { id: leaveId, status: "PENDING", stage: "MANAGER" }, data: { currentApproverId: ouverte.fromUserId } });
    return true;
  });
  if (!r) return { ok: false, error: "Cette demande vient d'être tranchée — rechargez la page." };
  const leave = await prisma.leaveRequest.findUnique({ where: { id: leaveId }, select: { employee: { select: { fullName: true } } } });
  await notifyUser({
    userId: ouverte.fromUserId, type: "GENERIC", title: "Congé validé par votre N+1",
    body: `${await nomDe(user.id)} a validé le congé de ${leave?.employee.fullName ?? "—"}${note ? ` (« ${note} »)` : ""} : à vous de le valider pour qu'il continue.`,
    link: LIEN_CONGES_A_SIGNER,
  }).catch(sansBloquer("conge-escalade.trancherSousEscalade.notifyUser"));
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: "Ressources humaines", entityType: "LEAVE_REQUEST", entityId: leaveId,
    summary: `Avis favorable sur le congé de ${leave?.employee.fullName ?? "—"} — redescend chez ${await nomDe(ouverte.fromUserId)}${note ? ` — « ${note} »` : ""}`,
  });
  return { ok: true, message: `Validé — la demande redescend chez ${await nomDe(ouverte.fromUserId)}, qui la fera continuer.` };
}
