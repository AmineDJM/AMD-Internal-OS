import { NextResponse } from "next/server";
import { identiteDuSondage } from "@/lib/session-legere";
import { prisma } from "@/lib/prisma";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";
import { clauseOuvrablesDe } from "@/lib/notifications/admission";

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

  // Les notifications qu'elle peut encore OUVRIR (25/11/2026) — la clause est gardée une minute par personne.
  const ouvrables = await clauseOuvrablesDe(user.id, user.role);
  const [unread, popups] = await Promise.all([
    prisma.notification.count({ where: { AND: [{ userId: user.id, isRead: false }, ouvrables] } }),
    prisma.notification.findMany({
      where: { AND: [{ userId: user.id, isRead: false, popup: true }, ouvrables] },
      select: { id: true, title: true, body: true, link: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
  ]);

  // Le lien ACTUEL : une pop-up d'hier peut porter l'adresse d'un module déplacé depuis.
  const aJour = popups.map((p) => ({ ...p, link: reécriteLienNotification(p.link) }));
  return NextResponse.json({ unread, popups: aJour }, { headers: { "Cache-Control": "private, no-store" } });
}
