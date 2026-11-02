import { NextResponse } from "next/server";
import { identiteDuSondage } from "@/lib/session-legere";
import { prisma } from "@/lib/prisma";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";

export const dynamic = "force-dynamic";

/**
 * Compteur de notifications non lues (sonnerie de rappel) + notifications **pop-up** non lues
 * (grande fenêtre centrée) à afficher / accuser réception. Sondé côté client.
 *
 * L'identité est celle des SONDAGES (`session-legere.ts`, PERF-06) : on ne lit que SES notifications,
 * la matrice des droits n'a rien à décider ici — 1 requête au lieu de 10 pour savoir qui appelle.
 */
export async function GET() {
  const user = await identiteDuSondage();
  if (!user || user.mustChangePassword) return NextResponse.json({ unread: 0, popups: [] }, { status: 200 });

  const [unread, popups] = await Promise.all([
    prisma.notification.count({ where: { userId: user.id, isRead: false } }),
    prisma.notification.findMany({
      where: { userId: user.id, isRead: false, popup: true },
      select: { id: true, title: true, body: true, link: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
  ]);

  // Le lien ACTUEL : une pop-up d'hier peut porter l'adresse d'un module déplacé depuis.
  const aJour = popups.map((p) => ({ ...p, link: reécriteLienNotification(p.link) }));
  return NextResponse.json({ unread, popups: aJour }, { headers: { "Cache-Control": "private, no-store" } });
}
