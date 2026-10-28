import crypto from "crypto";
import type { ConversationMember, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { shouldTouch } from "./touch-throttle";
import { emettreMessageRecu } from "./events/messaging-events";
import { sansBloquer } from "@/lib/journal";

// LA PART PURE vit dans `messaging-ui.ts` (importable par le navigateur) ; le serveur la retrouve ici.
export { presenceOf, PRESENCE_LABEL, CHAT_STATUSES, CHAT_STATUS_LABEL, normalizeChatStatus, preview, peutGererLaConversation, peutRetirerUnMessage } from "./messaging-ui";
export type { Presence, ChatStatus, RoleConversation } from "./messaging-ui";

/**
 * Cœur de la messagerie interne — règles d'accès & présence. MODULE SERVEUR : il lit la base
 * et inscrit des faits ; un composant client importe `messaging-ui.ts`, jamais ce fichier.
 *
 * Principe de sécurité : l'accès à une conversation est **strictement** gouverné
 * par l'appartenance (ConversationMember actif), jamais par un scope RBAC global.
 * On ne voit, n'écrit et ne télécharge que dans les conversations dont on est
 * membre — y compris un Super Admin (la messagerie reste un espace de confiance ;
 * l'entreprise possède la donnée, mais pas de « lecture par-dessus l'épaule » ici).
 */

/** Renvoie l'adhésion active de l'utilisateur à une conversation (ou null). */
export async function getActiveMembership(
  userId: string,
  conversationId: string,
): Promise<ConversationMember | null> {
  return prisma.conversationMember.findFirst({
    where: { userId, conversationId, leftAt: null },
  });
}

/** Indique si l'utilisateur peut accéder à la conversation (membre actif). */
export async function canAccessConversation(userId: string, conversationId: string): Promise<boolean> {
  return (await getActiveMembership(userId, conversationId)) !== null;
}

/**
 * ÉCRIT UN MESSAGE DIRECT — le geste COMMUN à l'écran, à l'assistant et aux relances d'Adam.
 *
 * Trouve (ou crée) la conversation 1-1, écrit le message, date la conversation, marque le
 * message lu par son auteur, et INSCRIT LE FAIT (`MESSAGE_RECEIVED`) au registre canonique :
 * un message interne, et la réponse qu'il appellera, sont des événements que des missions
 * peuvent attendre. Un seul chemin d'écriture, donc un seul endroit où le fait est émis — trois
 * copies de cette séquence divergeaient déjà (assistant, relances, écran).
 *
 * Ne vérifie AUCUN droit : l'appelant l'a fait (`userCan(MESSAGING, CREATE)` côté humain, le
 * compte système côté Adam). Ne notifie pas : la notification est une politique de l'appelant.
 */
export async function envoyerMessageDirect(opts: {
  senderId: string; recipientId: string; body: string;
  senderName?: string | null; senderEmail?: string | null; missionId?: string | null;
}): Promise<{ conversationId: string; messageId: string; createdAt: Date }> {
  let conversationId = await findDirectConversation(opts.senderId, opts.recipientId);
  if (!conversationId) {
    const conv = await prisma.conversation.create({
      data: { type: "DIRECT", createdById: opts.senderId, members: { create: [{ userId: opts.senderId }, { userId: opts.recipientId }] } },
      select: { id: true },
    });
    conversationId = conv.id;
  }
  const msg = await prisma.message.create({
    data: { conversationId, senderId: opts.senderId, kind: "TEXT", body: opts.body },
    select: { id: true, createdAt: true },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: msg.createdAt } });
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId: opts.senderId }, data: { lastReadAt: msg.createdAt },
  }).catch(sansBloquer("messaging.envoyerMessageDirect.conversationMember"));
  await emettreMessageRecu({
    conversationId, messageId: msg.id, senderId: opts.senderId, senderName: opts.senderName ?? undefined,
    senderEmail: opts.senderEmail ?? undefined, body: opts.body, recipientIds: [opts.recipientId],
    ...(opts.missionId ? { missionId: opts.missionId } : {}),
  });
  return { conversationId, messageId: msg.id, createdAt: msg.createdAt };
}

/** Cherche le message direct (1-1) déjà existant entre deux utilisateurs. */
export async function findDirectConversation(a: string, b: string): Promise<string | null> {
  const existing = await prisma.conversation.findFirst({
    where: {
      type: "DIRECT",
      AND: [
        { members: { some: { userId: a } } },
        { members: { some: { userId: b } } },
      ],
    },
    select: { id: true },
  });
  return existing?.id ?? null;
}

/** Sélecteur compact pour afficher un utilisateur dans la messagerie. */
export const messagingUserSelect = {
  id: true,
  name: true,
  title: true,
  role: true,
  avatarColor: true,
  lastSeenAt: true,
  isActive: true,
  chatStatus: true,
  statusMessage: true,
} satisfies Prisma.UserSelect;

// ─────────────────────────── Signature des pièces jointes ───────────────────────────
// Une pièce jointe est référencée par l'id de son blob chiffré. Pour empêcher un
// client de référencer un blob arbitraire (ex. un fichier du Drive) dont il ne
// possède pas le contenu, la route d'upload signe l'id du blob ; `sendMessage` ne
// crée une pièce jointe que si la signature est valide.

function blobSecret(): string {
  return process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "amd-internal-os";
}

export function signBlob(blobId: string): string {
  return crypto.createHmac("sha256", blobSecret()).update(blobId).digest("hex").slice(0, 32);
}

export function verifyBlob(blobId: string, sig: string): boolean {
  try {
    const expected = signBlob(blobId);
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

/** Met à jour la présence (best-effort, ne casse jamais l'appel parent). Throttlé à ≈ 1×/min
 *  par utilisateur : le polling messagerie appelle cette fonction toutes les ~6 s — inutile de
 *  réécrire `lastSeenAt` aussi souvent (réduction drastique des écritures disque). */
export async function touchPresence(userId: string): Promise<void> {
  if (!shouldTouch(`pres:${userId}`, 45_000)) return;
  await prisma.user
    .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
    .catch(sansBloquer("messaging.touchPresence.user"));
}


/**
 * Extrait les identifiants mentionnés à partir d'une liste candidate.
 * La saisie passe les ids choisis dans l'autocomplétion ; on ne garde que ceux
 * qui sont réellement membres de la conversation (sécurité + cohérence).
 */
export function sanitizeMentionIds(raw: string | null, memberIds: Set<string>, selfId: string): string[] {
  if (!raw) return [];
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const id of ids) if (id !== selfId && memberIds.has(id)) out.add(id);
  return [...out];
}
