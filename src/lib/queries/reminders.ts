import { prisma } from "@/lib/prisma";

/** Rappels ACTIFS d'un utilisateur (à venir ou déjà notifiés mais non traités), les plus proches d'abord. */
export async function listMyReminders(userId: string, take = 50) {
  return prisma.reminder.findMany({
    where: { userId, status: { in: ["PENDING", "SENT"] } },
    orderBy: { remindAt: "asc" },
    take,
    select: { id: true, title: true, note: true, link: true, remindAt: true, status: true, sentAt: true },
  });
}
