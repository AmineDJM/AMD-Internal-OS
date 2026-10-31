import { UserRole as UserRoleValues } from "@prisma/client";
import type { NotificationType, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { rejouerNotifications } from "@/lib/notifications/ecrire";
import { sendPushToUser } from "@/lib/push";

interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  /** Options du push (ex. appel entrant : reste affiché + vibre). Non stockées en base. */
  push?: { tag?: string; requireInteraction?: boolean };
}

/** Create an internal notification for a user (best-effort) + push sur ses appareils. */
export async function notifyUser(input: NotifyInput) {
  const { push, ...row } = input;
  try {
    await prisma.notification.create({ data: row });
  } catch (err) {
    console.error("[notify] failed", err);
  }
  // Push (PWA) — best-effort, auto-configuré (VAPID généré/persisté si absent).
  await sendPushToUser(input.userId, { title: input.title, body: input.body, url: input.link ?? "/", tag: push?.tag, requireInteraction: push?.requireInteraction });
}

export type BroadcastAudience = "ALL" | "ROLE" | "USERS";

/** Les comptes ACTIFS d'une audience de diffusion (tous, un rôle — principal ou secondaire —, des personnes). */
export async function destinatairesDeLaDiffusion(opts: { audience: BroadcastAudience; role?: string | null; userIds?: string[] }): Promise<string[]> {
  if (opts.audience === "USERS") {
    const ids = [...new Set((opts.userIds ?? []).filter(Boolean))];
    if (!ids.length) return [];
    return (await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } })).map((u) => u.id);
  }
  // Audience « rôle » : couvre le rôle principal ET le rôle secondaire.
  const where = opts.audience === "ROLE" && opts.role
    ? { isActive: true, ...anyRoleFilter([opts.role as UserRole]) }
    : { isActive: true };
  return (await prisma.user.findMany({ where, select: { id: true } })).map((u) => u.id);
}

/**
 * Diffuse une notification à une **audience** : tous les comptes actifs, un rôle,
 * ou des personnes précises. Renvoie le nombre de destinataires. Best-effort.
 */
export async function broadcastNotification(opts: {
  audience: BroadcastAudience;
  role?: string | null;
  userIds?: string[];
  title: string;
  body?: string;
  link?: string;
  /** Affiche aussi la notification en **pop-up plein écran** (grande fenêtre centrée) chez le destinataire. */
  popup?: boolean;
}, sortie?: { notificationIds?: string[] }): Promise<number> {
  try {
    const ids = await destinatairesDeLaDiffusion(opts);
    if (ids.length === 0) return 0;
    // UN DESTINATAIRE DISPARU NE DOIT PAS FAIRE TAIRE TOUT L'ENVOI : le lot est le chemin
    // rapide, et un lot refusé se rejoue ligne à ligne (§118.137). Le nombre rendu est celui des
    // lignes RÉELLEMENT écrites, jamais celui des destinataires qu'on espérait joindre — sans
    // quoi on annoncerait « 200 personnes prévenues » sur 199 (§118.51).
    const lignes = ids.map((userId) => ({ id: nouvelIdNotification(), userId, type: "GENERIC" as NotificationType, title: opts.title, body: opts.body, link: opts.link, popup: opts.popup ?? false }));
    let ecrites = lignes.length;
    try {
      await prisma.notification.createMany({ data: lignes });
    } catch (err) {
      ecrites = await rejouerNotifications(lignes, err);
    }
    // Push (PWA) sur les appareils de chaque destinataire — best-effort.
    await Promise.all(ids.map((userId) => sendPushToUser(userId, { title: opts.title, body: opts.body, url: opts.link ?? "/" })));
    // Les identifiants écrits (K10c) : la compensation d'une diffusion partie retire les non lues, rectifie les autres.
    if (sortie) sortie.notificationIds = lignes.map((l) => l.id);
    return ecrites;
  } catch (err) {
    console.error("[notify] broadcast failed", err);
    return 0;
  }
}

/** Une clé au format des `cuid()` du schéma — fixée avant l'écriture en lot, pour retrouver chaque ligne. */
const nouvelIdNotification = (): string => `c${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** Notify every user holding one of the given roles — en principal OU en secondaire
 *  (ex. un compte « délégué » dont l'autre rôle est National Sales doit être prévenu). */
export async function notifyRoles(
  roles: import("@prisma/client").UserRole[],
  input: Omit<NotifyInput, "userId">,
) {
  try {
    // UN NOM DE RÔLE INVENTÉ NE DOIT PAS FAIRE TAIRE TOUT L'ENVOI. Prisma refuse la requête
    // entière dès qu'une valeur n'appartient pas à l'énumération ; l'erreur atterrit dans le
    // `catch` ci-dessous et plus personne n'est prévenu — y compris les rôles corrects de la
    // même liste. C'est exactement ce qui a privé l'étape RH des congés de toute notification.
    const connus = roles.filter((r) => r in UserRoleValues);
    if (connus.length !== roles.length) {
      console.error("[notify] rôle(s) inconnu(s) ignoré(s) :", roles.filter((r) => !(r in UserRoleValues)));
    }
    if (connus.length === 0) return;
    const users = await prisma.user.findMany({
      where: { ...anyRoleFilter(connus), isActive: true },
      select: { id: true },
    });
    if (users.length === 0) return;
    // UN DESTINATAIRE DISPARU NE DOIT PAS FAIRE TAIRE TOUT L'ENVOI — même règle que le rôle
    // inventé ci-dessus, par l'autre porte : les comptes sont LUS puis écrits, et l'un d'eux peut
    // s'effacer entre les deux. Sans le rejeu, la clé étrangère fait rejeter le lot ENTIER et
    // personne n'est prévenu (§118.137).
    const lignes = users.map((u) => ({ ...input, userId: u.id }));
    try {
      await prisma.notification.createMany({ data: lignes });
    } catch (err) {
      await rejouerNotifications(lignes, err);
    }
    await Promise.all(users.map((u) => sendPushToUser(u.id, { title: input.title, body: input.body, url: input.link ?? "/" })));
  } catch (err) {
    console.error("[notify] failed (roles)", err);
  }
}
