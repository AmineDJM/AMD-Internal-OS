import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { GMAIL_BASE } from "../config";
import { googleJson } from "../client";
import { getActiveGoogleConnection } from "../connection";
import { buildMimeMessage, toGmailRaw, type MimeAttachment } from "./mime";
import { getAttachmentBytes } from "./messages";
import type { MailTransport, OutboundAttachmentRef } from "@/lib/comms/outbound";

/**
 * LE TRANSPORT GMAIL — ce qui fait réellement partir un message.
 *
 * Ce module est délibérément BÊTE : il ne décide rien. La politique, l'approbation, l'unicité de
 * l'envoi et l'empreinte du contenu sont tranchées en amont, dans `comms/outbound.ts`. Ici on
 * assemble le MIME, on résout les pièces et on appelle Google.
 *
 * Cette séparation n'est pas cosmétique : si la règle « pas d'envoi sans approbation » vivait
 * dans le transport, un second transport (Microsoft, demain) la ré-implémenterait — et un jour
 * l'oublierait. Le transport est remplaçable ; l'autorité, non.
 */

const USER = "users/me";
/** Gmail refuse au-delà de ~25 Mo ; on borne plus bas pour laisser la place à l'encodage base64. */
const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

/** Résout les pièces RÉFÉRENCÉES en octets, au moment de l'envoi (jamais stockées dans l'intention). */
async function resolveAttachments(refs: OutboundAttachmentRef[], accessToken: string): Promise<MimeAttachment[]> {
  const out: MimeAttachment[] = [];
  let total = 0;
  for (const ref of refs.slice(0, 10)) {
    let content: Buffer | null = null;
    let mimeType = ref.mimeType ?? "application/octet-stream";

    if (ref.driveNodeId) {
      const node = await prisma.driveNode.findUnique({
        where: { id: ref.driveNodeId },
        select: { name: true, mimeType: true, isTrashed: true, type: true },
      });
      if (!node || node.isTrashed || node.type !== "FILE") throw new Error(`Pièce jointe introuvable : ${ref.filename}`);
      const version = await prisma.fileVersion.findFirst({
        where: { nodeId: ref.driveNodeId }, orderBy: { version: "desc" }, select: { blobId: true },
      });
      if (!version) throw new Error(`Pièce jointe sans contenu : ${ref.filename}`);
      content = await getBlob(version.blobId);
      mimeType = node.mimeType ?? mimeType;
    } else if (ref.emailAttachmentId) {
      const att = await prisma.emailAttachmentRecord.findUnique({
        where: { id: ref.emailAttachmentId },
        select: { providerAttachmentId: true, filename: true, mimeType: true, emailRecord: { select: { providerMessageId: true } } },
      });
      if (!att?.providerAttachmentId) throw new Error(`Pièce reçue introuvable : ${ref.filename}`);
      content = await getAttachmentBytes(accessToken, att.emailRecord.providerMessageId, att.providerAttachmentId);
      mimeType = att.mimeType ?? mimeType;
    }

    if (!content || content.length === 0) throw new Error(`Pièce jointe illisible : ${ref.filename}`);
    total += content.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Pièces jointes trop volumineuses (18 Mo au total) — partagez plutôt un lien Drive.");
    }
    out.push({ filename: ref.filename, mimeType, content });
  }
  return out;
}

/**
 * Le transport Gmail, prêt à être passé à `sendOutboundIntent`.
 *
 * `threadId` est transmis à Google quand on répond : c'est lui, avec `In-Reply-To`/`References`,
 * qui fait apparaître la réponse DANS la conversation existante plutôt que d'en ouvrir une
 * nouvelle chez le destinataire.
 */
export const gmailTransport: MailTransport = {
  async send(msg) {
    const conn = await prisma.googleConnection.findUnique({
      where: { id: msg.connectionId },
      select: { userId: true, address: true, displayName: true },
    });
    if (!conn) throw new Error("Connexion Google introuvable.");
    const active = await getActiveGoogleConnection(conn.userId);
    if (!active) throw new Error("Le compte Google d'Adam n'est pas connecté (ou est suspendu).");

    const attachments = await resolveAttachments(msg.attachments ?? [], active.accessToken);
    const mime = buildMimeMessage({
      from: active.address,
      fromName: active.displayName,
      to: msg.recipients,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      text: msg.bodyText,
      html: msg.bodyHtml,
      inReplyTo: msg.inReplyTo,
      references: msg.referencesHeader,
      attachments,
    });

    const res = await googleJson<{ id?: string; threadId?: string }>({
      method: "POST",
      url: `${GMAIL_BASE}/${USER}/messages/send`,
      accessToken: active.accessToken,
      body: { raw: toGmailRaw(mime), ...(msg.threadId ? { threadId: msg.threadId } : {}) },
    });
    if (!res.id) throw new Error("Google n'a pas confirmé l'envoi.");
    return { providerMessageId: String(res.id), providerThreadId: res.threadId ? String(res.threadId) : null };
  },
};
