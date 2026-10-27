import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { presenceOf, preview, messagingUserSelect, type Presence } from "@/lib/messaging";
import { estImageAffichable } from "@/lib/messaging-attachments";

/**
 * Couche de lecture de la messagerie interne. Toutes les fonctions sont
 * paramétrées par `selfId` et n'exposent que des conversations dont l'utilisateur
 * est membre actif (`getConversationDetail` / `getThreadRefresh` renvoient `null`
 * sinon). Les dates sont sérialisées en ISO pour traverser proprement la frontière
 * serveur → client.
 */

// ─────────────────────────── DTOs ───────────────────────────

export interface DirectoryUserDTO {
  id: string;
  name: string;
  title: string | null;
  role: string;
  avatarColor: string | null;
  departmentName: string | null;
  presence: Presence;
  existingConversationId: string | null;
}

export interface ConversationSummaryDTO {
  id: string;
  type: "DIRECT" | "GROUP" | "CHANNEL";
  title: string;
  subtitle: string;
  avatarName: string;
  avatarColor: string | null;
  icon: string | null;
  isPinned: boolean;
  isMuted: boolean;
  notifyLevel: "ALL" | "MENTIONS" | "NONE";
  isArchived: boolean;
  myRole: "OWNER" | "ADMIN" | "MEMBER";
  memberCount: number;
  otherUserId: string | null;
  presence: Presence;
  unread: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastSenderName: string | null;
  lastSenderIsSelf: boolean;
}

export interface ReactionDTO {
  emoji: string;
  count: number;
  mine: boolean;
  users: string[];
}

export interface AttachmentDTO {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Image que le navigateur affiche (PNG, JPEG, GIF, WebP, SVG…) — téléversée OU référencée au Drive : vignette + visionneuse. */
  isImage: boolean;
  /** Nœud du Drive RÉFÉRENCÉ (rien n'a été recopié) — null pour un fichier téléversé. */
  driveNodeId: string | null;
  /** Vrai quand la référence désigne un dossier : il se navigue, il ne s'aperçoit pas. */
  isFolder: boolean;
}

export interface MessageDTO {
  id: string;
  kind: "TEXT" | "SYSTEM" | "FILE";
  body: string;
  deleted: boolean;
  senderId: string | null;
  senderName: string;
  senderColor: string | null;
  createdAt: string;
  editedAt: string | null;
  isPinned: boolean;
  bookmarked: boolean;
  parentId: string | null;
  parent: { id: string; senderName: string; preview: string } | null;
  reactions: ReactionDTO[];
  attachments: AttachmentDTO[];
  mentionIds: string[];
  refType: string | null;
  refId: string | null;
  refLabel: string | null;
  // Accusé façon messagerie, uniquement sur MES messages (DIRECT/GROUP) : envoyé → distribué → lu.
  receipt?: "sent" | "delivered" | "read";
}

export interface ConvMemberDTO {
  userId: string;
  name: string;
  title: string | null;
  role: string;
  memberRole: "OWNER" | "ADMIN" | "MEMBER";
  avatarColor: string | null;
  presence: Presence;
}

export interface ConversationDetailDTO {
  id: string;
  type: "DIRECT" | "GROUP" | "CHANNEL";
  title: string;
  description: string | null;
  avatarName: string;
  avatarColor: string | null;
  icon: string | null;
  otherUserId: string | null;
  presence: Presence;
  otherLastSeenAt: string | null; // dernière présence de l'autre (DIRECT) → « vu à HH:MM »
  otherChatStatus: string | null; // statut manuel de l'autre (façon Teams)
  otherStatusMessage: string | null; // message perso de l'autre
  isPinned: boolean;
  isMuted: boolean;
  notifyLevel: "ALL" | "MENTIONS" | "NONE";
  isArchived: boolean;
  myRole: "OWNER" | "ADMIN" | "MEMBER";
  createdByName: string | null;
  memberCount: number;
  members: ConvMemberDTO[];
  messages: MessageDTO[];
  pinnedMessages: MessageDTO[];
}

export interface BookmarkDTO {
  message: MessageDTO;
  conversationId: string;
  conversationTitle: string;
}

// ─────────────────────────── Includes & mapping ───────────────────────────

const messageIncludeShape = {
  sender: { select: { id: true, name: true, avatarColor: true } },
  reactions: { include: { user: { select: { id: true, name: true } } } },
  attachments: true,
  mentions: { select: { userId: true } },
  bookmarks: { select: { id: true } },
  parent: {
    select: { id: true, body: true, kind: true, deletedAt: true, sender: { select: { name: true } } },
  },
} satisfies Prisma.MessageInclude;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageIncludeShape }>;

/** Include with the bookmark filter scoped to the current user. */
export function messageInclude(selfId: string): Prisma.MessageInclude {
  return { ...messageIncludeShape, bookmarks: { where: { userId: selfId }, select: { id: true } } };
}

export function mapMessage(m: MessageRow, selfId: string): MessageDTO {
  const deleted = m.deletedAt !== null;
  const byEmoji = new Map<string, ReactionDTO>();
  for (const r of m.reactions) {
    const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, users: [] };
    entry.count += 1;
    entry.users.push(r.user.name);
    if (r.userId === selfId) entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  return {
    id: m.id,
    kind: m.kind,
    body: deleted ? "" : m.body,
    deleted,
    senderId: m.senderId,
    senderName: m.sender?.name ?? "Utilisateur supprimé",
    senderColor: m.sender?.avatarColor ?? null,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    isPinned: m.isPinned,
    bookmarked: m.bookmarks.length > 0,
    parentId: m.parentId,
    parent: m.parent
      ? {
          id: m.parent.id,
          senderName: m.parent.sender?.name ?? "—",
          preview: m.parent.deletedAt ? "message supprimé" : preview(m.parent.body, m.parent.kind, false, 60),
        }
      : null,
    reactions: deleted ? [] : [...byEmoji.values()],
    attachments: deleted
      ? []
      : m.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          // Une RÉFÉRENCE au Drive s'affiche aussi en vignette : son contenu passe par la route des
          // pièces jointes (`?contenu=1`), qui vérifie la participation puis renvoie au Drive, qui
          // vérifie la lecture. Un TIFF ou un HEIC, que `<img>` ne montre pas, reste une carte fichier.
          isImage: !a.isFolder && estImageAffichable(a.name, a.mime),
          driveNodeId: a.driveNodeId,
          isFolder: a.isFolder,
        })),
    mentionIds: m.mentions.map((x) => x.userId),
    refType: m.refType,
    refId: m.refId,
    refLabel: m.refLabel,
  };
}

// ─────────────────────────── Accusés de lecture (coches façon messagerie) ───────────────────────────
// « distribué » = tous les AUTRES membres actifs ont un heartbeat (lastSeenAt) postérieur au message
// (leur client a synchronisé) ; « lu » = tous ont un accusé de lecture (lastReadAt) postérieur. On
// prend le MINIMUM sur les autres membres : en groupe, il faut que TOUT le monde ait vu/lu (WhatsApp).

type ReceiptMember = { userId: string; lastReadAt: Date | null; user: { lastSeenAt: Date | null } };

function receiptThresholds(members: ReceiptMember[], selfId: string): { read: number | null; delivered: number | null } | null {
  const others = members.filter((m) => m.userId !== selfId);
  if (others.length === 0) return null;
  let read: number | null = Number.POSITIVE_INFINITY;
  let delivered: number | null = Number.POSITIVE_INFINITY;
  for (const o of others) {
    const r = o.lastReadAt ? o.lastReadAt.getTime() : null;
    const s = o.user.lastSeenAt ? o.user.lastSeenAt.getTime() : null;
    read = r === null || read === null ? null : Math.min(read, r);
    delivered = s === null || delivered === null ? null : Math.min(delivered, s);
  }
  return { read: read === Number.POSITIVE_INFINITY ? null : read, delivered: delivered === Number.POSITIVE_INFINITY ? null : delivered };
}

/** Annote MES messages d'un accusé (envoyé → distribué → lu). Ignoré pour les canaux (diffusion). */
function annotateReceipts(messages: MessageDTO[], members: ReceiptMember[], selfId: string, type: string): void {
  if (type === "CHANNEL") return;
  const th = receiptThresholds(members, selfId);
  if (!th) return;
  for (const m of messages) {
    if (m.senderId !== selfId || m.deleted || m.kind === "SYSTEM") continue;
    const t = new Date(m.createdAt).getTime();
    m.receipt = th.read !== null && th.read >= t ? "read" : th.delivered !== null && th.delivered >= t ? "delivered" : "sent";
  }
}

// ─────────────────────────── Conversation description ───────────────────────────

type MemberWithUser = Prisma.ConversationMemberGetPayload<{ include: { user: { select: typeof messagingUserSelect } } }>;
type ConversationCore = {
  type: "DIRECT" | "GROUP" | "CHANNEL";
  title: string | null;
  color: string | null;
  icon: string | null;
};

function describe(c: ConversationCore, members: MemberWithUser[], selfId: string) {
  const others = members.filter((m) => m.userId !== selfId);
  if (c.type === "DIRECT") {
    const other = others[0]?.user;
    return {
      title: other?.name ?? "Conversation",
      subtitle: other?.title ?? "",
      avatarName: other?.name ?? "?",
      avatarColor: other?.avatarColor ?? null,
      icon: null as string | null,
      otherUserId: other?.id ?? null,
      presence: presenceOf(other?.lastSeenAt),
    };
  }
  const title = c.title ?? (c.type === "CHANNEL" ? "Canal" : "Groupe");
  return {
    title,
    subtitle: `${members.length} membre${members.length > 1 ? "s" : ""}`,
    avatarName: title,
    avatarColor: c.color,
    icon: c.icon,
    otherUserId: null as string | null,
    presence: "offline" as Presence,
  };
}

// ─────────────────────────── Getters ───────────────────────────

/** Compteur de non-lus par conversation, en une seule requête. */
async function unreadByConversation(selfId: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
    SELECT m."conversationId" AS "conversationId", COUNT(msg.id)::int AS unread
    FROM "ConversationMember" m
    JOIN "Message" msg
      ON msg."conversationId" = m."conversationId"
     AND msg."deletedAt" IS NULL
     AND (msg."senderId" IS NULL OR msg."senderId" <> m."userId")
     AND (m."lastReadAt" IS NULL OR msg."createdAt" > m."lastReadAt")
    WHERE m."userId" = ${selfId} AND m."leftAt" IS NULL
    GROUP BY m."conversationId"
  `;
  return new Map(rows.map((r) => [r.conversationId, Number(r.unread)]));
}

/** Total de messages non lus (hors conversations en sourdine) — pour le badge global. */
export async function getTotalUnread(selfId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ unread: number }[]>`
    SELECT COUNT(msg.id)::int AS unread
    FROM "ConversationMember" m
    JOIN "Message" msg
      ON msg."conversationId" = m."conversationId"
     AND msg."deletedAt" IS NULL
     AND (msg."senderId" IS NULL OR msg."senderId" <> m."userId")
     AND (m."lastReadAt" IS NULL OR msg."createdAt" > m."lastReadAt")
    WHERE m."userId" = ${selfId} AND m."leftAt" IS NULL AND m."isMuted" = false
  `;
  return rows[0] ? Number(rows[0].unread) : 0;
}

interface DernierMessage {
  body: string;
  kind: string;
  createdAt: Date;
  senderId: string | null;
  senderName: string | null;
  hasAttachment: boolean;
}

/**
 * Le DERNIER MESSAGE NON SUPPRIMÉ de chaque conversation — une ligne par conversation, lue par l'index
 * `(conversationId, createdAt)`. Un message supprimé ne s'aperçoit plus nulle part, pas même dans l'aperçu
 * de la liste (Direction, 06/10 : « Vous : Hahahahaha » après suppression).
 *
 * En SQL et non en `include: { messages: { take: 1 } }` : sous une LISTE de parents, Prisma 5 n'émet
 * pas ce `take` — il rapatrie tout l'historique de chaque conversation, corps compris, et coupe en
 * mémoire (audit performance PERF-01, `messaging-sync-perf.test.ts`). Or cette lecture sert le polling
 * de 12 s de chaque onglet ouvert.
 */
async function derniersMessages(conversationIds: string[]): Promise<Map<string, DernierMessage>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<(DernierMessage & { conversationId: string })[]>`
    SELECT c.id AS "conversationId", l.body, l.kind::text AS kind, l."createdAt", l."senderId",
           u.name AS "senderName",
           EXISTS (SELECT 1 FROM "MessageAttachment" a WHERE a."messageId" = l.id) AS "hasAttachment"
    FROM unnest(${conversationIds}::text[]) AS c(id)
    CROSS JOIN LATERAL (
      SELECT m.id, m.body, m.kind, m."createdAt", m."senderId"
      FROM "Message" m
      WHERE m."conversationId" = c.id AND m."deletedAt" IS NULL
      ORDER BY m."createdAt" DESC
      LIMIT 1
    ) l
    LEFT JOIN "User" u ON u.id = l."senderId"
  `;
  return new Map(rows.map(({ conversationId, ...r }) => [conversationId, r]));
}

/** Liste des conversations de l'utilisateur, triée (épinglées puis récentes). */
export async function getConversationSummaries(selfId: string): Promise<ConversationSummaryDTO[]> {
  const [memberships, unread] = await Promise.all([
    prisma.conversationMember.findMany({
      where: { userId: selfId, leftAt: null },
      include: {
        conversation: {
          include: {
            members: { where: { leftAt: null }, include: { user: { select: messagingUserSelect } } },
          },
        },
      },
    }),
    unreadByConversation(selfId),
  ]);
  const derniers = await derniersMessages(memberships.map((m) => m.conversationId));

  const summaries = memberships.map((mem) => {
    const c = mem.conversation;
    const d = describe(c, c.members, selfId);
    const last = derniers.get(c.id);
    return {
      id: c.id,
      type: c.type,
      title: d.title,
      subtitle: d.subtitle,
      avatarName: d.avatarName,
      avatarColor: d.avatarColor,
      icon: d.icon,
      isPinned: mem.isPinned,
      isMuted: mem.isMuted,
      notifyLevel: mem.notifyLevel,
      isArchived: c.isArchived,
      myRole: mem.role,
      memberCount: c.members.length,
      otherUserId: d.otherUserId,
      presence: d.presence,
      unread: unread.get(c.id) ?? 0,
      lastMessageAt: (last?.createdAt ?? c.lastMessageAt).toISOString(),
      lastMessagePreview: last ? preview(last.body, last.kind, last.hasAttachment) : "",
      lastSenderName: last?.senderName ?? null,
      lastSenderIsSelf: last != null && last.senderId === selfId,
    } satisfies ConversationSummaryDTO;
  });

  summaries.sort(
    (a, b) => Number(b.isPinned) - Number(a.isPinned) || b.lastMessageAt.localeCompare(a.lastMessageAt),
  );
  return summaries;
}

export interface SyncPayload {
  conversations: ConversationSummaryDTO[];
  totalUnread: number;
  serverTime: string;
}

/** Charge utile du polling de la liste + badge global. */
export async function getSync(selfId: string): Promise<SyncPayload> {
  const conversations = await getConversationSummaries(selfId);
  const totalUnread = conversations.reduce((s, c) => s + (c.isMuted ? 0 : c.unread), 0);
  return { conversations, totalUnread, serverTime: new Date().toISOString() };
}

/** Annuaire interne : qui contacter (tous les comptes actifs sauf soi-même). */
export async function getDirectory(selfId: string): Promise<DirectoryUserDTO[]> {
  const [users, directs] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, id: { not: selfId } },
      select: { ...messagingUserSelect, department: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.conversation.findMany({
      where: { type: "DIRECT", members: { some: { userId: selfId } } },
      select: { id: true, members: { select: { userId: true } } },
    }),
  ]);
  const dmMap = new Map<string, string>();
  for (const d of directs) {
    const other = d.members.find((m) => m.userId !== selfId);
    if (other) dmMap.set(other.userId, d.id);
  }
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    title: u.title,
    role: u.role,
    avatarColor: u.avatarColor,
    departmentName: u.department?.name ?? null,
    presence: presenceOf(u.lastSeenAt),
    existingConversationId: dmMap.get(u.id) ?? null,
  }));
}

/** Détail complet d'une conversation (ou null si non membre). */
export async function getConversationDetail(
  selfId: string,
  conversationId: string,
  limit = 120,
): Promise<ConversationDetailDTO | null> {
  const membership = await prisma.conversationMember.findFirst({
    where: { userId: selfId, conversationId, leftAt: null },
  });
  if (!membership) return null;

  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      createdBy: { select: { name: true } },
      members: {
        where: { leftAt: null },
        include: { user: { select: messagingUserSelect } },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!c) return null;

  const [rows, pinnedRows] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: messageInclude(selfId),
    }),
    prisma.message.findMany({
      where: { conversationId, isPinned: true, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: messageInclude(selfId),
    }),
  ]);

  const d = describe(c, c.members, selfId);
  const messages = rows.reverse().map((m) => mapMessage(m as unknown as MessageRow, selfId));
  annotateReceipts(messages, c.members, selfId, c.type);
  const otherMember = c.type === "DIRECT" ? c.members.find((m) => m.userId !== selfId) : null;
  return {
    id: c.id,
    type: c.type,
    title: d.title,
    description: c.description,
    avatarName: d.avatarName,
    avatarColor: d.avatarColor,
    icon: d.icon,
    otherUserId: d.otherUserId,
    presence: d.presence,
    otherLastSeenAt: otherMember?.user.lastSeenAt ? otherMember.user.lastSeenAt.toISOString() : null,
    otherChatStatus: otherMember?.user.chatStatus ?? null,
    otherStatusMessage: otherMember?.user.statusMessage ?? null,
    isPinned: membership.isPinned,
    isMuted: membership.isMuted,
    notifyLevel: membership.notifyLevel,
    isArchived: c.isArchived,
    myRole: membership.role,
    createdByName: c.createdBy?.name ?? null,
    memberCount: c.members.length,
    members: c.members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      title: m.user.title,
      role: m.user.role,
      memberRole: m.role,
      avatarColor: m.user.avatarColor,
      presence: presenceOf(m.user.lastSeenAt),
    })),
    messages,
    pinnedMessages: pinnedRows.map((m) => mapMessage(m as unknown as MessageRow, selfId)),
  };
}

export interface ThreadRefresh {
  ok: boolean;
  messages: MessageDTO[];
  pinnedMessages: MessageDTO[];
  presence: Record<string, Presence>;
  otherLastSeenAt: string | null;
}

/** Rafraîchissement léger du fil actif (polling) — messages + présence membres + accusés. */
export async function getThreadRefresh(
  selfId: string,
  conversationId: string,
  limit = 120,
): Promise<ThreadRefresh> {
  const membership = await prisma.conversationMember.findFirst({
    where: { userId: selfId, conversationId, leftAt: null },
    select: { id: true, conversation: { select: { type: true } } },
  });
  if (!membership) return { ok: false, messages: [], pinnedMessages: [], presence: {}, otherLastSeenAt: null };

  const [rows, pinnedRows, members] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: messageInclude(selfId),
    }),
    prisma.message.findMany({
      where: { conversationId, isPinned: true, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: messageInclude(selfId),
    }),
    prisma.conversationMember.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true, lastReadAt: true, user: { select: { lastSeenAt: true } } },
    }),
  ]);

  const presence: Record<string, Presence> = {};
  for (const m of members) presence[m.userId] = presenceOf(m.user.lastSeenAt);

  const type = membership.conversation.type;
  const messages = rows.reverse().map((m) => mapMessage(m as unknown as MessageRow, selfId));
  annotateReceipts(messages, members, selfId, type);
  const otherMember = type === "DIRECT" ? members.find((m) => m.userId !== selfId) : null;

  return {
    ok: true,
    messages,
    pinnedMessages: pinnedRows.map((m) => mapMessage(m as unknown as MessageRow, selfId)),
    presence,
    otherLastSeenAt: otherMember?.user.lastSeenAt ? otherMember.user.lastSeenAt.toISOString() : null,
  };
}

export interface ChannelDTO {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  memberCount: number;
}

/** Canaux d'équipe que l'utilisateur peut découvrir et rejoindre (non membre). */
export async function getDiscoverableChannels(selfId: string): Promise<ChannelDTO[]> {
  const channels = await prisma.conversation.findMany({
    where: {
      type: "CHANNEL",
      isArchived: false,
      members: { none: { userId: selfId, leftAt: null } },
    },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      icon: true,
      color: true,
      _count: { select: { members: true } },
    },
  });
  return channels.map((c) => ({
    id: c.id,
    title: c.title ?? "Canal",
    description: c.description,
    icon: c.icon,
    color: c.color,
    memberCount: c._count.members,
  }));
}

/** Messages enregistrés (favoris) de l'utilisateur, avec leur contexte. */
export async function getBookmarks(selfId: string): Promise<BookmarkDTO[]> {
  const bookmarks = await prisma.messageBookmark.findMany({
    where: { userId: selfId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      message: {
        include: {
          ...messageIncludeShape,
          bookmarks: { where: { userId: selfId }, select: { id: true } },
          conversation: { select: { id: true, type: true, title: true, members: { where: { leftAt: null }, select: { userId: true, user: { select: { name: true } } } } } },
        },
      },
    },
  });

  return bookmarks.map((b) => {
    const conv = b.message.conversation;
    let title = conv.title ?? "Conversation";
    if (conv.type === "DIRECT") {
      const other = conv.members.find((m) => m.userId !== selfId);
      title = other?.user.name ?? "Message direct";
    }
    return {
      message: mapMessage(b.message as unknown as MessageRow, selfId),
      conversationId: conv.id,
      conversationTitle: title,
    };
  });
}
