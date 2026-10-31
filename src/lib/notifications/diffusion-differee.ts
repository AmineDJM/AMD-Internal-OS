import { prisma, prismaBrut } from "@/lib/prisma";
import { broadcastNotification, notifyUser } from "@/lib/notify";
import type { Charge, Expediteur } from "@/lib/effets/fenetre";

/**
 * LA DIFFUSION DE NOTIFICATIONS DIFFÉRÉE (K10c) — l'expéditeur de `notification-actions:sendBroadcast`.
 *
 * La charge porte les destinataires FIXÉS au clic (le compte annoncé est celui qui partira) et le contenu. Partie,
 * sa compensation (écrite par `prisma` : sous le journal de l'annulation, « rétablir » la défait) : chaque
 * notification encore NON LUE est retirée (elle n'a été vue qu'en poussée, sur l'écran d'un appareil), chaque
 * notification LUE reçoit un rectificatif. Ce qui ne se défait pas, et se dit : la poussée
 * déjà affichée sur les téléphones, et la lecture par ceux qui l'ont ouverte.
 */

export interface ChargeDiffusion extends Charge {
  userIds: string[];
  title: string;
  body: string | null;
  link: string | null;
  popup: boolean;
}

export const expediteurDiffusion: Expediteur = {
  async envoyer(charge) {
    const c = charge as ChargeDiffusion;
    const sortie: { notificationIds?: string[] } = {};
    const ecrites = await broadcastNotification({ audience: "USERS", userIds: c.userIds, title: c.title, body: c.body ?? undefined, link: c.link ?? undefined, popup: c.popup }, sortie);
    return { ecrites, notificationIds: sortie.notificationIds ?? [] };
  },
  async compenser(charge, resultat, ctx) {
    const c = charge as ChargeDiffusion;
    const ids = Array.isArray(resultat?.notificationIds) ? (resultat!.notificationIds as string[]) : [];
    const lignes = ids.length ? await prismaBrut.notification.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true, isRead: true } }) : [];
    const nonLues = lignes.filter((l) => !l.isRead);
    const lues = lignes.filter((l) => l.isRead);
    if (ctx.appliquer) {
      if (nonLues.length) await prisma.notification.deleteMany({ where: { id: { in: nonLues.map((l) => l.id) }, isRead: false } });
      for (const l of lues) {
        await notifyUser({
          userId: l.userId, type: "GENERIC", title: `Rectificatif : « ${c.title} »`.slice(0, 200),
          body: `${ctx.parNom} a annulé cette diffusion : ne tenez plus compte du message « ${c.title} ».`,
        });
      }
    }
    const fait = [
      nonLues.length ? `${nonLues.length} notification(s) non lue(s) retirée(s)` : "",
      lues.length ? `un rectificatif envoyé aux ${lues.length} personne(s) qui l'avaient lue` : "",
    ].filter(Boolean).join(", ") || "plus aucune notification à retirer";
    return { fait, irreversible: `la notification poussée déjà affichée sur les appareils de ${c.userIds.length} personne(s)${lues.length ? `, et la lecture par ${lues.length} d'entre elles` : ""} — elle n'est pas effacée chez eux` };
  },
};
