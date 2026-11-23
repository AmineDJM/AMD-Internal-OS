import { prisma } from "@/lib/prisma";
import { RECURRENCE_LABEL, type ReminderRecurrence } from "@/lib/assistant/reminders";
import type { RappelVue } from "@/lib/rappels/vue";

const JOURS_RECUS = 30;

/**
 * TOUS LES RAPPELS D'UNE PERSONNE (recette du 23/11/2026) — voir `lib/rappels/vue.ts` pour les onglets.
 *   · personnels : TOUS ceux à traiter (aucun plafond silencieux : 500 couvre largement une personne),
 *     plus les 50 derniers terminés ou annulés ;
 *   · de l'assistant : ceux que la personne possède, actifs ou arrêtés (100 derniers) ;
 *   · reçus : les échéances (proches, dépassées) et les relances des 30 derniers jours (50). Les
 *     notifications « Rappel » des rappels personnels n'y sont pas : le rappel lui-même est déjà listé.
 */
export async function listerMesRappels(userId: string): Promise<RappelVue[]> {
  const depuis = new Date(Date.now() - JOURS_RECUS * 86_400_000);
  const [actifs, faits, assistant, recus] = await Promise.all([
    prisma.reminder.findMany({
      where: { userId, status: { in: ["PENDING", "SENT"] } },
      orderBy: { remindAt: "asc" }, take: 500,
      select: { id: true, title: true, note: true, link: true, remindAt: true, status: true },
    }),
    prisma.reminder.findMany({
      where: { userId, status: { in: ["DONE", "CANCELLED"] } },
      orderBy: { updatedAt: "desc" }, take: 50,
      select: { id: true, title: true, note: true, link: true, remindAt: true, status: true, updatedAt: true },
    }),
    prisma.assistantReminder.findMany({
      where: { userId },
      orderBy: [{ active: "desc" }, { dueAt: "asc" }], take: 100,
      select: { id: true, title: true, note: true, link: true, dueAt: true, active: true, recurrence: true, updatedAt: true },
    }),
    prisma.notification.findMany({
      where: {
        userId, createdAt: { gte: depuis },
        OR: [
          { type: { in: ["DEADLINE_NEAR", "LATE"] } },
          { title: { startsWith: "Relance", mode: "insensitive" } },
          { AND: [{ title: { startsWith: "Rappel", mode: "insensitive" } }, { NOT: { title: "Rappel" } }] },
        ],
      },
      orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, title: true, body: true, link: true, isRead: true, createdAt: true },
    }),
  ]);
  return [
    ...actifs.map((r): RappelVue => ({
      key: `perso:${r.id}`, id: r.id, source: "perso", titre: r.title, note: r.note, lien: r.link,
      quand: r.remindAt.toISOString(), statut: r.status, recurrence: null,
    })),
    // Terminés ou annulés : datés du moment où ils l'ont été.
    ...faits.map((r): RappelVue => ({
      key: `perso:${r.id}`, id: r.id, source: "perso", titre: r.title, note: r.note, lien: r.link,
      quand: r.updatedAt.toISOString(), statut: r.status, recurrence: null,
    })),
    ...assistant.map((a): RappelVue => ({
      key: `assistant:${a.id}`, id: a.id, source: "assistant", titre: a.title, note: a.note, lien: a.link,
      quand: (a.active ? a.dueAt : a.updatedAt).toISOString(), statut: a.active ? "ACTIVE" : "INACTIVE",
      recurrence: a.recurrence !== "NONE" ? (RECURRENCE_LABEL[a.recurrence as ReminderRecurrence] ?? a.recurrence.toLowerCase()) : null,
    })),
    ...recus.map((n): RappelVue => ({
      key: `recu:${n.id}`, id: n.id, source: "recu", titre: n.title, note: n.body, lien: n.link,
      quand: n.createdAt.toISOString(), statut: n.isRead ? "LU" : "NON_LU", recurrence: null,
    })),
  ];
}
