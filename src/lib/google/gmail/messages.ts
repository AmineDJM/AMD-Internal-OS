import { GMAIL_BASE } from "../config";
import { googleJson } from "../client";
import { decodeGmailBody, parseAddress, parseAddressList } from "./mime";

/**
 * GMAIL EN LECTURE — chercher, ouvrir, suivre un fil, récupérer une pièce.
 *
 * Google reste la SOURCE DE VÉRITÉ des messages : ce module ne recopie pas la boîte, il la lit et
 * la NORMALISE. Ce que le reste du Chief manipule est un objet stable (`GmailMessage`) : le jour
 * où une autre messagerie s'ajoute, c'est ce type-là qu'elle produira, et rien au-dessus ne
 * changera.
 *
 * Le corps est aplati en TEXTE. Un courriel HTML contient des balises, des styles, parfois des
 * pixels espions ; les donner tels quels à un modèle, c'est du bruit — et une porte d'entrée
 * (voir `sanitize`). On garde le texte, et l'original reste chez Google, à un clic.
 */

const USER = "users/me";

export interface GmailAttachmentMeta {
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  historyId: string | null;
  labelIds: string[];
  snippet: string;
  /** En-têtes RFC utiles au fil de discussion. */
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string;
  sentAt: Date | null;
  bodyText: string;
  attachments: GmailAttachmentMeta[];
  /** En-têtes bruts en minuscules — nécessaires à la détection des expéditeurs automatiques. */
  headers: Record<string, string>;
}

interface RawPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: RawPart[];
}

interface RawMessage {
  id?: string;
  threadId?: string;
  historyId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: RawPart;
}

function headerMap(part: RawPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of part?.headers ?? []) {
    if (h.name) out[h.name.toLowerCase()] = h.value ?? "";
  }
  return out;
}

/**
 * Aplatit l'arbre MIME : le texte d'un côté, les pièces de l'autre.
 *
 * On préfère `text/plain` quand il existe ; sinon on déshabille le HTML. Le repli n'est pas un
 * luxe : beaucoup d'expéditeurs (et tous les clients modernes) n'envoient QUE du HTML, et sans
 * ce chemin Adam recevrait des messages vides.
 */
function walk(part: RawPart | undefined, acc: { text: string[]; html: string[]; attachments: GmailAttachmentMeta[] }): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ?? "";

  if (filename && (part.body?.attachmentId || part.body?.size)) {
    acc.attachments.push({
      attachmentId: part.body?.attachmentId ?? null,
      filename,
      mimeType: mime || "application/octet-stream",
      sizeBytes: Number(part.body?.size ?? 0),
    });
    return;
  }
  if (mime === "text/plain") acc.text.push(decodeGmailBody(part.body?.data));
  else if (mime === "text/html") acc.html.push(decodeGmailBody(part.body?.data));
  for (const child of part.parts ?? []) walk(child, acc);
}

/** HTML → texte lisible : on retire scripts et styles AVANT de retirer les balises. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeMessage(raw: RawMessage): GmailMessage {
  const h = headerMap(raw.payload);
  const acc = { text: [] as string[], html: [] as string[], attachments: [] as GmailAttachmentMeta[] };
  walk(raw.payload, acc);
  const text = acc.text.join("\n").trim() || htmlToText(acc.html.join("\n"));
  const internal = Number(raw.internalDate ?? 0);

  return {
    id: String(raw.id ?? ""),
    threadId: String(raw.threadId ?? ""),
    historyId: raw.historyId ? String(raw.historyId) : null,
    labelIds: raw.labelIds ?? [],
    snippet: raw.snippet ?? "",
    rfcMessageId: h["message-id"] ?? null,
    inReplyTo: h["in-reply-to"] ?? null,
    references: h["references"] ?? null,
    from: parseAddress(h["from"] ?? ""),
    to: parseAddressList(h["to"]),
    cc: parseAddressList(h["cc"]),
    subject: h["subject"] ?? "",
    sentAt: Number.isFinite(internal) && internal > 0 ? new Date(internal) : null,
    bodyText: text,
    attachments: acc.attachments,
    headers: h,
  };
}

export interface GmailListOptions {
  /** Requête Gmail (`from:deepak has:attachment newer_than:7d`). */
  q?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
}

export async function listMessageIds(
  accessToken: string,
  opts: GmailListOptions = {},
): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken: string | null }> {
  const res = await googleJson<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>({
    url: `${GMAIL_BASE}/${USER}/messages`,
    accessToken,
    query: {
      q: opts.q,
      maxResults: opts.maxResults ?? 25,
      pageToken: opts.pageToken,
      includeSpamTrash: opts.includeSpamTrash ? "true" : undefined,
      ...(opts.labelIds?.length ? { labelIds: opts.labelIds.join(",") } : {}),
    },
  });
  return { ids: res.messages ?? [], nextPageToken: res.nextPageToken ?? null };
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const raw = await googleJson<RawMessage>({
    url: `${GMAIL_BASE}/${USER}/messages/${encodeURIComponent(id)}`,
    accessToken,
    query: { format: "full" },
  });
  return normalizeMessage(raw);
}

/** Le FIL complet — c'est le contexte, pas le message isolé, qui permet de comprendre. */
export async function getThread(accessToken: string, threadId: string): Promise<GmailMessage[]> {
  const raw = await googleJson<{ messages?: RawMessage[] }>({
    url: `${GMAIL_BASE}/${USER}/threads/${encodeURIComponent(threadId)}`,
    accessToken,
    query: { format: "full" },
  });
  return (raw.messages ?? []).map(normalizeMessage);
}

/** Les octets d'une pièce jointe — à la demande, jamais stockés par défaut. */
export async function getAttachmentBytes(accessToken: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const res = await googleJson<{ data?: string; size?: number }>({
    url: `${GMAIL_BASE}/${USER}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    accessToken,
  });
  if (!res.data) return Buffer.alloc(0);
  return Buffer.from(res.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Le profil de la boîte — adresse servie et `historyId` courant (point de départ du suivi). */
export async function getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string | null; messagesTotal: number }> {
  const res = await googleJson<{ emailAddress?: string; historyId?: string; messagesTotal?: number }>({
    url: `${GMAIL_BASE}/${USER}/profile`,
    accessToken,
  });
  return {
    emailAddress: (res.emailAddress ?? "").toLowerCase(),
    historyId: res.historyId ? String(res.historyId) : null,
    messagesTotal: Number(res.messagesTotal ?? 0),
  };
}
