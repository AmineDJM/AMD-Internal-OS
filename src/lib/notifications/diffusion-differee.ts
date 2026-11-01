import { prisma, prismaBrut } from "@/lib/prisma";
import { broadcastNotification, notifyUser } from "@/lib/notify";
import type { ExecuteurEffetSortant } from "@/lib/effets/fenetre";

/**
 * LA DIFFUSION DE NOTIFICATIONS DIFFÉRÉE (K10c, décision 0041) — l'exécuteur `notification.diffusion` de la fenêtre
 * d'annulation (K10b, `lib/effets/fenetre.ts`), pour `notification-actions:sendBroadcast`.
 *
 * La charge porte les destinataires FIXÉS au clic (le compte annoncé est celui qui partira), le contenu, et les
 * IDENTIFIANTS des notifications qu'elle écrira (tirés au clic) : la compensation les retrouve sans rien deviner.
 * Annulée dans la fenêtre : rien n'est parti. Partie : chaque notification encore NON LUE est retirée, chaque
 * notification LUE reçoit un rectificatif (écrits par `prisma` : sous le journal de l'annulation, « rétablir » les
 * défait). Ce qui ne se défait pas, et se dit : la poussée affichée sur les appareils.
 */

export interface ChargeDiffusion {
  userIds: string[];
  notificationIds: string[];
  title: string;
  body: string | null;
  link: string | null;
  popup: boolean;
}

export const executeurDiffusion: ExecuteurEffetSortant = {
  async executer(charge) {
    const c = charge as ChargeDiffusion;
    await broadcastNotification({ audience: "USERS", userIds: c.userIds, title: c.title, body: c.body ?? undefined, link: c.link ?? undefined, popup: c.popup }, { idsFixes: c.notificationIds });
  },
  async compensation(charge) {
    const c = charge as ChargeDiffusion;
    const lignes = c.notificationIds.length ? await prismaBrut.notification.findMany({ where: { id: { in: c.notificationIds } }, select: { id: true, userId: true, isRead: true } }) : [];
    const nonLues = lignes.filter((l) => !l.isRead);
    const lues = lignes.filter((l) => l.isRead);
    if (nonLues.length) await prisma.notification.deleteMany({ where: { id: { in: nonLues.map((l) => l.id) }, isRead: false } });
    for (const l of lues) {
      await notifyUser({
        userId: l.userId, type: "GENERIC", title: `Rectificatif : « ${c.title} »`.slice(0, 200),
        body: `Cette diffusion a été annulée : ne tenez plus compte du message « ${c.title} ».`,
      });
    }
    const fait = [
      nonLues.length ? `${nonLues.length} notification(s) non lue(s) retirée(s)` : "",
      lues.length ? `un rectificatif envoyé aux ${lues.length} personne(s) qui l'avaient lue` : "",
    ].filter(Boolean).join(", ") || "plus aucune notification à retirer";
    return { fait: `${fait} ; la notification poussée déjà affichée sur les appareils de ${c.userIds.length} personne(s) n'est pas effacée chez eux` };
  },
};
