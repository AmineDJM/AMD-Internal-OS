"use server";

import { revalidatePath } from "next/cache";
import { EntityType, type ConvMemberRole, type ConvNotifyLevel } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { emettreMessageRecu } from "@/lib/events/messaging-events";
import { notifyUser } from "@/lib/notify";
import { resolveDriveAccess } from "@/lib/drive";
import {
  MAX_ATTACHMENTS, recipientsToGrant, DOSSIER_MESSAGERIE, nomDossierConversation, nomLotMessagerie, piecesDuLot,
} from "@/lib/messaging-attachments";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import {
  canAccessConversation,
  getActiveMembership,
  findDirectConversation,
  sanitizeMentionIds,
  verifyBlob,
  preview,
  normalizeChatStatus,
  peutGererLaConversation,
  peutRetirerUnMessage,
} from "@/lib/messaging";

/**
 * Définit/actualise le **statut de messagerie** (façon Teams) de l'utilisateur : statut manuel
 * (Disponible / Occupé / Ne pas déranger / De retour bientôt / Absent / Hors ligne) + message
 * personnel court. Statut vide → retour au mode automatique (présence par heartbeat).
 */
export async function setMessagingStatus(formData: FormData): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const status = normalizeChatStatus((formData.get("status") as string) || null);
  const message = ((formData.get("message") as string) || "").trim().slice(0, 120) || null;
  await prisma.user.update({ where: { id: user.id }, data: { chatStatus: status, statusMessage: message } });
  return { ok: true };
}
import { mapMessage, messageInclude, type MessageRow, type MessageDTO } from "@/lib/queries/messaging";
import { fdStr, fdBool, type ActionResult } from "@/lib/actions/types";
import { inscrirePiece } from "@/modules/bibliotheque/api-inscription";

const DENIED: ActionResult = { ok: false, error: "Non autorisé." };

// ─────────────────────────── Helpers internes ───────────────────────────

/** Émet un message « système » dans la conversation et remonte sa date. */
async function systemMessage(conversationId: string, body: string): Promise<void> {
  const m = await prisma.message.create({ data: { conversationId, senderId: null, kind: "SYSTEM", body } });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: m.createdAt } });
}

/** Ids de membres valides (comptes actifs, hors soi-même), dédoublonnés. */
async function validMemberIds(raw: string | null, selfId: string): Promise<string[]> {
  if (!raw) return [];
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].filter((id) => id !== selfId);
  if (!ids.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
  return users.map((u) => u.id);
}

interface ParsedAttachment {
  blobId: string;
  name: string;
  mime: string;
  size: number;
}

/** Valide les pièces jointes : la signature HMAC prouve qu'un blob provient bien
 *  de notre route d'upload (interdit de référencer un blob arbitraire). */
function parseAttachments(raw: string | null): ParsedAttachment[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: ParsedAttachment[] = [];
    for (const a of arr.slice(0, 10)) {
      if (!a || typeof a.blobId !== "string" || typeof a.sig !== "string") continue;
      if (!verifyBlob(a.blobId, a.sig)) continue;
      out.push({
        blobId: a.blobId,
        name: String(a.name ?? "fichier").slice(0, 200),
        mime: String(a.mime ?? "application/octet-stream").slice(0, 120),
        size: Math.max(0, Math.min(Math.round(Number(a.size) || 0), 2_000_000_000)),
      });
    }
    return out;
  } catch {
    return [];
  }
}

interface ParsedDriveRef {
  nodeId: string;
  name: string;
  mime: string;
  size: number;
  isFolder: boolean;
  ownerId: string | null;
}

/**
 * LES RÉFÉRENCES AU DRIVE d'un message — validées contre les droits de l'EXPÉDITEUR.
 *
 * On ne fait pas confiance au client : il envoie des identifiants de nœuds, et `resolveDriveAccess`
 * dit si cette personne y a réellement accès. Sans cette vérification, n'importe qui pourrait
 * s'accorder — et accorder à toute une conversation — la lecture d'un fichier qu'il n'a jamais vu,
 * en devinant un identifiant.
 *
 * Le nom, la taille et le type viennent de la BASE, jamais du formulaire : un nom soufflé par le
 * client afficherait « Note de service.pdf » sur un fichier tout autre.
 */
async function parseDriveRefs(user: SessionUser, raw: string | null): Promise<ParsedDriveRef[]> {
  if (!raw) return [];
  let ids: string[];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    ids = [...new Set(arr.map((x) => (typeof x === "string" ? x : String(x?.id ?? ""))).filter(Boolean))]
      .slice(0, MAX_ATTACHMENTS);
  } catch {
    return [];
  }
  if (ids.length === 0) return [];

  const nodes = await prisma.driveNode.findMany({
    where: { id: { in: ids }, isTrashed: false },
    select: { id: true, name: true, type: true, mimeType: true, size: true, ownerId: true },
  });

  const out: ParsedDriveRef[] = [];
  for (const n of nodes) {
    if ((await resolveDriveAccess(user, n.id)) === "NONE") continue; // partager ce qu'on ne voit pas : non
    out.push(refDuNoeud(n));
  }
  return out;
}

/**
 * La taille d'une pièce jointe est un `Int` (32 bits) ; celle d'un nœud du Drive un `Float`, qui tient
 * les fichiers de plus de 2 Go. Sans borne, joindre une référence à un fichier de 3 Go faisait ÉCHOUER
 * l'envoi du message entier (Direction, 06/10). La taille affichée plafonne à 2 Go ; le fichier, lui,
 * reste entier dans le Drive.
 */
const TAILLE_INT_MAX = 2_147_483_647;

function refDuNoeud(n: { id: string; name: string; type: string; mimeType: string | null; size: number; ownerId: string | null }): ParsedDriveRef {
  return {
    nodeId: n.id,
    name: n.name.slice(0, 200),
    mime: n.mimeType ?? (n.type === "FOLDER" ? "inode/directory" : "application/octet-stream"),
    size: Math.max(0, Math.min(Math.round(n.size || 0), TAILLE_INT_MAX)),
    isFolder: n.type === "FOLDER",
    ownerId: n.ownerId,
  };
}

/**
 * LES LOTS DÉPOSÉS DANS LE COMPOSITEUR (voir `preparerDepotMessagerie`), devenus pièces du message.
 *
 * Un lot n'est accepté que s'il est un dossier APPARTENANT à l'expéditeur — on ne fait pas joindre
 * le dossier d'un autre en devinant son identifiant. Son contenu est relu en base au moment de
 * l'envoi : ses éléments un par un s'ils tiennent dans la place restante, sinon le dossier du lot.
 */
async function parseDriveLots(user: SessionUser, rawIds: readonly string[], place: number, deja: ReadonlySet<string>): Promise<ParsedDriveRef[]> {
  const ids = [...new Set(rawIds.map((x) => x.trim()).filter(Boolean))].slice(0, MAX_ATTACHMENTS);
  const champs = { id: true, name: true, type: true, mimeType: true, size: true, ownerId: true } as const;
  const out: ParsedDriveRef[] = [];
  let reste = place;
  for (const id of ids) {
    const lot = await prisma.driveNode.findFirst({
      where: { id, type: "FOLDER", ownerId: user.id, isTrashed: false },
      select: champs,
    });
    if (!lot) continue;
    const elements = (await prisma.driveNode.findMany({
      where: { parentId: lot.id, isTrashed: false },
      select: champs,
      orderBy: { name: "asc" },
      take: MAX_ATTACHMENTS + 1, // au-delà, on sait déjà que ce sera le dossier
    })).filter((n) => !deja.has(n.id));
    const choix = piecesDuLot(elements.length, reste);
    if (choix === "elements") {
      out.push(...elements.map(refDuNoeud));
      reste -= elements.length;
    } else if (choix === "dossier") {
      out.push(refDuNoeud(lot));
      reste -= 1;
    }
  }
  return out;
}

/**
 * ACCORDER LA LECTURE aux destinataires d'un partage Drive.
 *
 * `skipDuplicates` n'est pas un détail de performance : la contrainte d'unicité protège un droit
 * EXISTANT. Réécrire la ligne poserait un `VIEW` par-dessus un `EDIT` — on retirerait l'édition à
 * quelqu'un en lui envoyant un message.
 *
 * Le partage porte sur le nœud désigné ; l'héritage du Drive fait le reste pour un dossier, dont
 * tout le contenu devient lisible — c'est exactement ce qu'on veut en envoyant une liasse.
 */
async function grantDriveRefAccess(refs: readonly ParsedDriveRef[], memberIds: readonly string[], senderId: string): Promise<void> {
  for (const ref of refs) {
    const existing = await prisma.driveShare.findMany({ where: { nodeId: ref.nodeId }, select: { userId: true } });
    const targets = recipientsToGrant(memberIds, {
      senderId,
      ownerId: ref.ownerId,
      alreadyShared: existing.map((s) => s.userId),
    });
    if (targets.length === 0) continue;
    await prisma.driveShare.createMany({
      data: targets.map((userId) => ({ nodeId: ref.nodeId, userId, access: "VIEW" as const })),
      skipDuplicates: true,
    });
  }
}

/**
 * LES PIÈCES DU DRIVE DÉJÀ JOINTES AU FIL, ouvertes à qui y ENTRE (ajouté à un groupe, canal rejoint,
 * retour après départ). L'envoi n'accorde la lecture qu'aux membres présents : sans ce rattrapage, le
 * nouveau venu voyait les pièces et ne pouvait rien en ouvrir (Direction, 27/10). Même règle que
 * `grantDriveRefAccess` (jamais un `VIEW` par-dessus un droit existant, ni à l'expéditeur, ni au
 * propriétaire) ; `resolveDriveAccess` lit aussi ce droit à l'ouverture — ce partage-ci range en plus
 * les pièces dans « son » Drive et ouvre la porte du module.
 */
async function accorderPiecesDuFil(conversationId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const pieces = await prisma.messageAttachment.findMany({
    where: { driveNodeId: { not: null }, message: { conversationId, deletedAt: null }, driveNode: { isTrashed: false } },
    select: { driveNodeId: true, message: { select: { senderId: true } }, driveNode: { select: { ownerId: true } } },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  if (pieces.length === 0) return;
  const nodeIds = [...new Set(pieces.map((p) => p.driveNodeId!))];
  const existants = await prisma.driveShare.findMany({
    where: { nodeId: { in: nodeIds }, userId: { in: [...userIds] } },
    select: { nodeId: true, userId: true },
  });
  const deja = new Set(existants.map((e) => `${e.nodeId}:${e.userId}`));
  const lignes = new Map<string, { nodeId: string; userId: string; access: "VIEW" }>();
  for (const p of pieces) {
    const nodeId = p.driveNodeId!;
    const cibles = recipientsToGrant(userIds, {
      senderId: p.message.senderId ?? "",
      ownerId: p.driveNode?.ownerId ?? null,
      alreadyShared: userIds.filter((u) => deja.has(`${nodeId}:${u}`)),
    });
    for (const userId of cibles) lignes.set(`${nodeId}:${userId}`, { nodeId, userId, access: "VIEW" });
  }
  if (lignes.size > 0) await prisma.driveShare.createMany({ data: [...lignes.values()], skipDuplicates: true });
}

/** Référence à un objet de l'OS partagé dans un message (validée contre EntityType). */
function parseRef(formData: FormData): { type: EntityType; id: string; label: string | null } | null {
  const type = fdStr(formData, "refType");
  const id = fdStr(formData, "refId");
  if (!type || !id) return null;
  if (!(Object.values(EntityType) as string[]).includes(type)) return null;
  return { type: type as EntityType, id, label: fdStr(formData, "refLabel") };
}

async function validParent(parentId: string | null, conversationId: string): Promise<string | null> {
  if (!parentId) return null;
  const p = await prisma.message.findFirst({
    where: { id: parentId, conversationId, deletedAt: null },
    select: { id: true },
  });
  return p?.id ?? null;
}

// ─────────────────────────── Création de conversations ───────────────────────────

export async function createDirect(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "VIEW")) return DENIED;
  const targetId = fdStr(formData, "userId");
  if (!targetId || targetId === user.id) return { ok: false, error: "Destinataire invalide." };
  const target = await prisma.user.findFirst({ where: { id: targetId, isActive: true }, select: { id: true } });
  if (!target) return { ok: false, error: "Utilisateur introuvable." };

  const existing = await findDirectConversation(user.id, targetId);
  if (existing) return { ok: true, id: existing };

  const conv = await prisma.conversation.create({
    data: {
      type: "DIRECT",
      createdById: user.id,
      members: { create: [{ userId: user.id }, { userId: targetId }] },
    },
    select: { id: true },
  });
  revalidatePath("/messages");
  return { ok: true, id: conv.id };
}

export async function createGroup(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "CREATE")) return DENIED;
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Le nom du groupe est obligatoire." };
  const memberIds = await validMemberIds(fdStr(formData, "members"), user.id);

  const conv = await prisma.conversation.create({
    data: {
      type: "GROUP",
      title,
      color: fdStr(formData, "color"),
      createdById: user.id,
      members: {
        create: [
          { userId: user.id, role: "OWNER" },
          ...memberIds.map((id) => ({ userId: id, role: "MEMBER" as ConvMemberRole })),
        ],
      },
    },
    select: { id: true },
  });
  await systemMessage(conv.id, `${user.name} a créé le groupe « ${title} ».`);
  revalidatePath("/messages");
  return { ok: true, id: conv.id };
}

export async function createChannel(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "CREATE")) return DENIED;
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Le nom du canal est obligatoire." };
  const memberIds = await validMemberIds(fdStr(formData, "members"), user.id);

  const conv = await prisma.conversation.create({
    data: {
      type: "CHANNEL",
      title,
      description: fdStr(formData, "description"),
      icon: fdStr(formData, "icon") ?? "Hash",
      color: fdStr(formData, "color"),
      createdById: user.id,
      members: {
        create: [
          { userId: user.id, role: "OWNER" },
          ...memberIds.map((id) => ({ userId: id, role: "MEMBER" as ConvMemberRole })),
        ],
      },
    },
    select: { id: true },
  });
  await systemMessage(conv.id, `${user.name} a créé le canal « ${title} ».`);
  revalidatePath("/messages");
  return { ok: true, id: conv.id };
}

// ─────────────────────────── Messages ───────────────────────────

/**
 * RECEVOIR UN MESSAGE EST UNE NOTIFICATION — plus seulement une mention.
 *
 * Le compteur de non-lus ne suffisait pas : il ne vit que dans l'écran Messages, ne sonne pas,
 * ne part pas en push sur le téléphone, et ne dit ni de qui ni quoi. Quelqu'un à qui l'on écrit
 * pendant qu'il travaille dans un autre module ne l'apprenait qu'en repassant par la messagerie.
 *
 * Trois règles, et elles suivent le réglage que la personne a choisi pour CETTE conversation :
 *  - `NONE` (silencieux) : rien, pas même une mention — c'est le sens du mot ;
 *  - `MENTIONS` : uniquement quand on la nomme ;
 *  - `ALL` (défaut) : chaque message.
 *
 * UNE SEULE LIGNE PAR CONVERSATION TANT QU'ELLE N'EST PAS LUE. Trente messages dans un fil ne
 * font pas trente notifications : on ne remplacerait pas un compteur muet par une cloche
 * inutilisable. Une MENTION, elle, passe toujours — elle s'adresse nommément à quelqu'un, et
 * l'étouffer derrière un message anodin arrivé avant serait exactement l'oubli qu'on corrige.
 */
async function notifyRecipients(opts: {
  conversationId: string;
  sender: { id: string; name: string };
  members: { userId: string; notifyLevel: ConvNotifyLevel }[];
  mentionIds: string[];
  body: string;
}) {
  const { conversationId, sender, members, mentionIds, body } = opts;
  const link = `/messages?c=${conversationId}`;
  const mentioned = new Set(mentionIds);

  const cibles = members.filter((m) => m.userId !== sender.id && m.notifyLevel !== "NONE");
  const aMentionner = cibles.filter((m) => mentioned.has(m.userId)).map((m) => m.userId);
  const aPrevenir = cibles.filter((m) => m.notifyLevel === "ALL" && !mentioned.has(m.userId)).map((m) => m.userId);

  // Qui a déjà une notification NON LUE sur cette conversation ? Elle dira la même chose.
  const dejaEnAttente = aPrevenir.length
    ? new Set(
        (await prisma.notification.findMany({
          where: { userId: { in: aPrevenir }, link, isRead: false },
          select: { userId: true },
        })).map((n) => n.userId),
      )
    : new Set<string>();

  await Promise.all([
    ...aMentionner.map((userId) => notifyUser({
      userId, type: "GENERIC", link,
      title: `${sender.name} vous a mentionné`,
      body,
    })),
    ...aPrevenir.filter((id) => !dejaEnAttente.has(id)).map((userId) => notifyUser({
      userId, type: "GENERIC", link,
      title: `Nouveau message de ${sender.name}`,
      body,
      // Un même fil ne réempile pas de bandeaux sur l'appareil : le push se REMPLACE.
      push: { tag: `conv-${conversationId}` },
    })),
  ]);
}

export async function sendMessage(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; message?: MessageDTO }> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "CREATE")) return { ok: false, error: "Non autorisé." };
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const membership = await getActiveMembership(user.id, conversationId);
  if (!membership) return { ok: false, error: "Vous n'êtes pas membre de cette conversation." };

  const body = (formData.get("body") ? String(formData.get("body")) : "").trim().slice(0, 8000);
  const attachments = parseAttachments(fdStr(formData, "attachments"));
  const refsChoisies = await parseDriveRefs(user, fdStr(formData, "driveRefs"));
  // Les lots déposés (gros fichiers, dossiers) — déjà dans le Drive de l'expéditeur, joints par référence.
  const refsDesLots = await parseDriveLots(
    user,
    formData.getAll("driveLot").map((v) => String(v ?? "")),
    MAX_ATTACHMENTS - attachments.length - refsChoisies.length,
    new Set(refsChoisies.map((r) => r.nodeId)),
  );
  const driveRefs = [...refsChoisies, ...refsDesLots];
  const pieces = attachments.length + driveRefs.length;
  if (!body && pieces === 0) return { ok: false, error: "Message vide." };

  const members = await prisma.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true, notifyLevel: true },
  });
  const memberIds = new Set(members.map((m) => m.userId));
  const mentionIds = sanitizeMentionIds(fdStr(formData, "mentions"), memberIds, user.id);
  const parentId = await validParent(fdStr(formData, "parentId"), conversationId);
  const ref = parseRef(formData);

  const created = await prisma.message.create({
    data: {
      conversationId,
      senderId: user.id,
      kind: pieces > 0 && !body ? "FILE" : "TEXT",
      body,
      parentId,
      refType: ref?.type ?? null,
      refId: ref?.id ?? null,
      refLabel: ref?.label ?? null,
      mentions: mentionIds.length ? { create: mentionIds.map((id) => ({ userId: id })) } : undefined,
      attachments: pieces
        ? {
            create: [
              ...attachments.map((a) => ({ blobId: a.blobId, name: a.name, mime: a.mime, size: a.size })),
              ...driveRefs.map((r) => ({
                driveNodeId: r.nodeId, isFolder: r.isFolder, name: r.name, mime: r.mime, size: r.size,
              })),
            ],
          }
        : undefined,
    },
    include: messageInclude(user.id),
  });

  // L'ACCÈS SUIT LE PARTAGE, et il le suit APRÈS la création du message : si l'écriture du
  // message échoue, on n'aura ouvert l'accès à rien.
  if (driveRefs.length > 0) await grantDriveRefAccess(driveRefs, [...memberIds], user.id);
  // Les pièces téléversées (le blob vient de `/api/messaging/upload`) entrent à la bibliothèque (J1), sous la clé de
  // la pièce jointe : la recherche les rend aux membres de la conversation. Une référence au Drive y est déjà.
  if (attachments.length > 0) {
    const jointes = await prisma.messageAttachment.findMany({ where: { messageId: created.id, blobId: { not: null } }, select: { id: true, blobId: true, name: true, mime: true, size: true } });
    for (const j of jointes) {
      await inscrirePiece({
        blobId: j.blobId!, nom: j.name, mime: j.mime, taille: j.size, source: "CONVERSATION",
        objet: { famille: "MESSAGE_PIECE", id: j.id }, proprietaireId: user.id, role: "piece-jointe",
      });
    }
  }

  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: created.createdAt } });
  await prisma.conversationMember.update({ where: { id: membership.id }, data: { lastReadAt: created.createdAt } });

  await notifyRecipients({
    conversationId, sender: user, members, mentionIds,
    body: preview(body, created.kind, pieces > 0, 120),
  });
  // LE FAIT : une mission qui attend la réponse de cette personne se réveille ici.
  await emettreMessageRecu({
    conversationId, messageId: created.id, senderId: user.id, senderName: user.name, senderEmail: user.email,
    body, recipientIds: members.map((m) => m.userId), hasAttachments: pieces > 0,
  });

  revalidatePath("/messages");
  return { ok: true, message: mapMessage(created as unknown as MessageRow, user.id) };
}

/**
 * PRÉPARER UN DÉPÔT DANS UNE CONVERSATION — gros fichiers, ZIP, dossiers entiers.
 *
 * Crée (ou reprend, avec `lotId`) le dossier de l'envoi dans le Drive PERSONNEL de l'expéditeur —
 * « Messagerie / <conversation> / Envoi du … » — puis l'arborescence des dossiers déposés (`dir`,
 * chemins relatifs). Rend la carte `chemin → dossier` : le navigateur y envoie ensuite chaque fichier
 * par les routes du Drive, exactement comme l'import de dossier du Drive (Direction, 06/10).
 *
 * L'expéditeur est PROPRIÉTAIRE du lot : cela suffit aux routes d'envoi du Drive (`refusDepotDrive`
 * demande l'édition du dossier cible, et le propriétaire l'a) — le droit module « Téléverser » du
 * Drive n'est pas requis ; c'est celui de la messagerie qui ouvre la porte ici.
 */
export async function preparerDepotMessagerie(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; lotId?: string; map?: Record<string, string> }> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "UPLOAD")) return { ok: false, error: "Non autorisé." };
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId || !(await canAccessConversation(user.id, conversationId))) {
    return { ok: false, error: "Conversation non autorisée." };
  }
  const dirs = [...new Set(formData.getAll("dir").map((d) => String(d ?? "").trim()).filter(Boolean))].slice(0, 5000);

  let lotId = fdStr(formData, "lotId");
  if (lotId) {
    const lot = await prisma.driveNode.findFirst({
      where: { id: lotId, type: "FOLDER", ownerId: user.id, isTrashed: false },
      select: { id: true },
    });
    if (!lot) return { ok: false, error: "Envoi introuvable — redéposez les fichiers." };
  } else {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { title: true, members: { where: { leftAt: null, userId: { not: user.id } }, select: { user: { select: { name: true } } }, take: 3 } },
    });
    const titre = conv?.title || conv?.members.map((m) => m.user.name).join(", ") || null;
    // Drive PERSONNEL (spaceId null) : un dossier « Messagerie » à la racine d'une catégorie ne compte pas.
    let parentId: string | null = null;
    for (const nom of [DOSSIER_MESSAGERIE, nomDossierConversation(titre)]) {
      const existant: { id: string } | null = await prisma.driveNode.findFirst({
        where: { type: "FOLDER", name: nom, parentId, ownerId: user.id, spaceId: null, isTrashed: false },
        select: { id: true },
      });
      parentId = existant?.id ?? (await prisma.driveNode.create({
        data: { name: nom, type: "FOLDER", parentId, ownerId: user.id, createdById: user.id },
        select: { id: true },
      })).id;
    }
    // Le dossier de l'envoi est TOUJOURS neuf : le message joindra son contenu, et rien d'autre.
    lotId = (await prisma.driveNode.create({
      data: { name: nomLotMessagerie(new Date()), type: "FOLDER", parentId, ownerId: user.id, createdById: user.id },
      select: { id: true },
    })).id;
  }

  const map = await creerArborescenceDrive({ ownerId: user.id, parentId: lotId, spaceId: null, paths: dirs });
  return { ok: true, lotId, map };
}

export async function editMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = (formData.get("body") ? String(formData.get("body")) : "").trim().slice(0, 8000);
  if (!id) return { ok: false, error: "Identifiant manquant." };
  if (!body) return { ok: false, error: "Le message ne peut pas être vide." };
  const msg = await prisma.message.findUnique({ where: { id }, select: { senderId: true, deletedAt: true } });
  if (!msg || msg.senderId !== user.id || msg.deletedAt) return { ok: false, error: "Modification impossible." };
  await prisma.message.update({ where: { id }, data: { body, editedAt: new Date() } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function deleteMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const msg = await prisma.message.findUnique({ where: { id }, select: { senderId: true, conversationId: true } });
  if (!msg) return { ok: false, error: "Message introuvable." };
  // Trois faits, nommés au socle et lus AUSSI par l'écran (`peutRetirerUnMessage`) : sans
  // cette lecture commune, l'action acceptait ce que le bouton ne proposait pas (§118.50).
  // La CHAÎNE `user.role` — donc sans casquette secondaire — est ce que l'écran lit lui aussi.
  const vueGlobale = hasGlobalView(user.role);
  // Un rôle à vue globale n'a pas à être membre : on n'interroge l'appartenance que quand
  // elle peut encore changer la décision.
  const membership = vueGlobale ? null : await getActiveMembership(user.id, msg.conversationId);
  // Quelqu'un qui a QUITTÉ la conversation ne modère plus ses anciens messages : c'est le
  // comportement d'origine, et l'élargir serait une décision de permission.
  if (!vueGlobale && !membership) return DENIED;
  const autorise = peutRetirerUnMessage({
    vueGlobale,
    auteur: msg.senderId === user.id,
    gereLaConversation: peutGererLaConversation(membership?.role),
  });
  if (!autorise) return DENIED;
  await prisma.message.update({ where: { id }, data: { deletedAt: new Date(), isPinned: false } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function toggleReaction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const messageId = fdStr(formData, "messageId");
  const emoji = fdStr(formData, "emoji");
  if (!messageId || !emoji || emoji.length > 12) return { ok: false, error: "Réaction invalide." };
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, deletedAt: true } });
  if (!msg || msg.deletedAt) return { ok: false, error: "Message indisponible." };
  if (!(await getActiveMembership(user.id, msg.conversationId))) return DENIED;

  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId: user.id, emoji } },
  });
  if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
  else await prisma.messageReaction.create({ data: { messageId, userId: user.id, emoji } });
  return { ok: true };
}

export async function togglePinMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "messageId");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const msg = await prisma.message.findUnique({ where: { id }, select: { conversationId: true, isPinned: true, deletedAt: true } });
  if (!msg || msg.deletedAt) return { ok: false, error: "Message indisponible." };
  if (!(await getActiveMembership(user.id, msg.conversationId))) return DENIED;
  await prisma.message.update({ where: { id }, data: { isPinned: !msg.isPinned } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function bookmarkMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const messageId = fdStr(formData, "messageId");
  if (!messageId) return { ok: false, error: "Identifiant manquant." };
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (!msg) return { ok: false, error: "Message introuvable." };
  if (!(await getActiveMembership(user.id, msg.conversationId))) return DENIED;
  const existing = await prisma.messageBookmark.findUnique({
    where: { messageId_userId: { messageId, userId: user.id } },
  });
  if (existing) await prisma.messageBookmark.delete({ where: { id: existing.id } });
  else await prisma.messageBookmark.create({ data: { messageId, userId: user.id } });
  return { ok: true };
}

export async function markRead(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const membership = await getActiveMembership(user.id, conversationId);
  if (!membership) return DENIED;
  await prisma.conversationMember.update({ where: { id: membership.id }, data: { lastReadAt: new Date() } });
  return { ok: true };
}

// ─────────────────────────── Préférences par conversation ───────────────────────────

export async function togglePinConversation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m) return DENIED;
  await prisma.conversationMember.update({ where: { id: m.id }, data: { isPinned: !m.isPinned } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function toggleMute(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m) return DENIED;
  await prisma.conversationMember.update({ where: { id: m.id }, data: { isMuted: !m.isMuted } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function setNotifyLevel(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  const level = fdStr(formData, "level");
  if (!conversationId || !level || !["ALL", "MENTIONS", "NONE"].includes(level)) return { ok: false, error: "Niveau invalide." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m) return DENIED;
  await prisma.conversationMember.update({ where: { id: m.id }, data: { notifyLevel: level as ConvNotifyLevel } });
  revalidatePath("/messages");
  return { ok: true };
}

// ─────────────────────────── Gestion des membres / conversation ───────────────────────────

export async function updateConversation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m || !peutGererLaConversation(m.role)) return DENIED;
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true, title: true } });
  if (!conv || conv.type === "DIRECT") return { ok: false, error: "Conversation non modifiable." };

  const title = fdStr(formData, "title");
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      title: title ?? conv.title,
      description: fdStr(formData, "description"),
      icon: fdStr(formData, "icon"),
      color: fdStr(formData, "color"),
    },
  });
  if (title && title !== conv.title) {
    await systemMessage(conversationId, `${user.name} a renommé la conversation en « ${title} ».`);
  }
  revalidatePath("/messages");
  return { ok: true };
}

export async function addMembers(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m || !peutGererLaConversation(m.role)) return DENIED;
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true } });
  if (!conv || conv.type === "DIRECT") return { ok: false, error: "Impossible d'ajouter des membres ici." };

  const ids = await validMemberIds(fdStr(formData, "members"), user.id);
  if (!ids.length) return { ok: false, error: "Aucun membre valide." };

  const added: string[] = [];
  for (const id of ids) {
    const existing = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: id } },
    });
    if (existing) {
      if (existing.leftAt) {
        await prisma.conversationMember.update({ where: { id: existing.id }, data: { leftAt: null, role: "MEMBER" } });
        added.push(id);
      }
    } else {
      await prisma.conversationMember.create({ data: { conversationId, userId: id, role: "MEMBER" } });
      added.push(id);
    }
  }
  if (added.length) {
    await accorderPiecesDuFil(conversationId, added);
    const names = await prisma.user.findMany({ where: { id: { in: added } }, select: { name: true } });
    await systemMessage(conversationId, `${user.name} a ajouté ${names.map((n) => n.name).join(", ")}.`);
  }
  revalidatePath("/messages");
  return { ok: true };
}

export async function removeMember(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  const userId = fdStr(formData, "userId");
  if (!conversationId || !userId) return { ok: false, error: "Paramètres manquants." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m || !peutGererLaConversation(m.role)) return DENIED;
  if (userId === user.id) return { ok: false, error: "Utilisez « Quitter » pour partir vous-même." };
  const target = await prisma.conversationMember.findFirst({ where: { conversationId, userId, leftAt: null } });
  if (!target) return { ok: false, error: "Membre introuvable." };
  await prisma.conversationMember.update({ where: { id: target.id }, data: { leftAt: new Date() } });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (u) await systemMessage(conversationId, `${user.name} a retiré ${u.name}.`);
  revalidatePath("/messages");
  return { ok: true };
}

export async function setMemberRole(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  const userId = fdStr(formData, "userId");
  const role = fdStr(formData, "role");
  if (!conversationId || !userId || !role || !["ADMIN", "MEMBER"].includes(role)) return { ok: false, error: "Paramètres invalides." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m || m.role !== "OWNER") return { ok: false, error: "Seul le propriétaire peut gérer les rôles." };
  const target = await prisma.conversationMember.findFirst({ where: { conversationId, userId, leftAt: null } });
  if (!target || target.role === "OWNER") return { ok: false, error: "Membre introuvable." };
  await prisma.conversationMember.update({ where: { id: target.id }, data: { role: role as ConvMemberRole } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function leaveConversation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m) return DENIED;
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true } });
  if (conv?.type === "DIRECT") return { ok: false, error: "On ne peut pas quitter un message direct." };
  await prisma.conversationMember.update({ where: { id: m.id }, data: { leftAt: new Date() } });
  await systemMessage(conversationId, `${user.name} a quitté la conversation.`);
  revalidatePath("/messages");
  return { ok: true };
}

export async function archiveConversation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation manquante." };
  const m = await getActiveMembership(user.id, conversationId);
  if (!m || !peutGererLaConversation(m.role)) return DENIED;
  await prisma.conversation.update({ where: { id: conversationId }, data: { isArchived: fdBool(formData, "archived") } });
  revalidatePath("/messages");
  return { ok: true };
}

export async function joinChannel(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "VIEW")) return DENIED;
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Canal manquant." };
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true, isArchived: true } });
  if (!conv || conv.type !== "CHANNEL" || conv.isArchived) return { ok: false, error: "Canal indisponible." };

  const existing = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.id } },
  });
  if (existing && !existing.leftAt) return { ok: true, id: conversationId };
  if (existing) await prisma.conversationMember.update({ where: { id: existing.id }, data: { leftAt: null, role: "MEMBER" } });
  else await prisma.conversationMember.create({ data: { conversationId, userId: user.id, role: "MEMBER" } });
  await accorderPiecesDuFil(conversationId, [user.id]);
  await systemMessage(conversationId, `${user.name} a rejoint le canal.`);
  revalidatePath("/messages");
  return { ok: true, id: conversationId };
}
