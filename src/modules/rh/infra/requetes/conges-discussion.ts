import { prisma } from "@/lib/prisma";
import type { CommentItem } from "@/components/shared/comment-thread";

/**
 * LA DISCUSSION DES CONGÉS (Direction, 07/10) — le fil `Comment` (entité `LEAVE_REQUEST`) de chaque demande, en UNE
 * requête pour le lot. L'appelant ne passe que des congés que l'écran montre déjà à la personne : cette lecture
 * n'ouvre rien de plus.
 */
export async function discussionsDesConges(ids: string[]): Promise<Record<string, CommentItem[]>> {
  const out: Record<string, CommentItem[]> = {};
  if (ids.length === 0) return out;
  const lignes = await prisma.comment.findMany({
    where: { entityType: "LEAVE_REQUEST", entityId: { in: ids } },
    include: { author: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const c of lignes) {
    (out[c.entityId] ??= []).push({
      id: c.id, author: c.author?.name ?? "Utilisateur", authorId: c.authorId, body: c.body,
      createdAt: c.createdAt.toISOString(), editedAt: c.editedAt?.toISOString() ?? null,
    });
  }
  return out;
}

/** Ce que la table « Congés et absences à trancher » des RH lit en plus de la file : qui a signé au N+1, le solde après. */
export interface ComplementConge {
  /** Le nom de qui a validé la marche du N+1 (`managerDecidedById`) — nul tant qu'elle n'est pas franchie. */
  n1Valide: string | null;
  /** Le solde du salarié une fois ce congé débité — congé ANNUEL seulement (les autres ne débitent rien). */
  soldeApres: number | null;
  commentaires: CommentItem[];
}

export async function complementsConges(ids: string[]): Promise<Record<string, ComplementConge>> {
  const out: Record<string, ComplementConge> = {};
  if (ids.length === 0) return out;
  const [conges, discussions] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true, days: true, managerDecidedById: true, employee: { select: { leaveBalanceDays: true } } },
    }),
    discussionsDesConges(ids),
  ]);
  const signataires = [...new Set(conges.map((c) => c.managerDecidedById).filter((v): v is string => Boolean(v)))];
  const noms = new Map(
    (signataires.length ? await prisma.user.findMany({ where: { id: { in: signataires } }, select: { id: true, name: true } }) : [])
      .map((u) => [u.id, u.name]),
  );
  for (const c of conges) {
    out[c.id] = {
      n1Valide: c.managerDecidedById ? noms.get(c.managerDecidedById) ?? null : null,
      soldeApres: c.type === "ANNUAL" ? Number(c.employee.leaveBalanceDays) - Number(c.days) : null,
      commentaires: discussions[c.id] ?? [],
    };
  }
  return out;
}
