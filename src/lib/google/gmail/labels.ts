import { GMAIL_BASE } from "../config";
import { googleJson } from "../client";

/**
 * RANGER LA BOÎTE — étiquettes, lu/non lu, archivage, corbeille.
 *
 * Ces gestes sont AUTONOMES : classer un message ne le fait pas sortir de l'entreprise, donc ils
 * n'attendent personne. La seule chose qu'Adam ne peut pas faire, structurellement, c'est
 * détruire un message sans retour possible — le droit `gmail.modify` ne le permet pas (voir
 * `config.ts`). Mettre à la corbeille reste réversible ; c'est délibéré.
 */

const USER = "users/me";

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesUnread?: number;
}

export async function listLabels(accessToken: string): Promise<GmailLabel[]> {
  const res = await googleJson<{ labels?: GmailLabel[] }>({ url: `${GMAIL_BASE}/${USER}/labels`, accessToken });
  return res.labels ?? [];
}

/** Crée une étiquette si elle n'existe pas — rend son identifiant dans tous les cas. */
export async function ensureLabel(accessToken: string, name: string): Promise<string> {
  const existing = (await listLabels(accessToken)).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const created = await googleJson<{ id?: string }>({
    method: "POST",
    url: `${GMAIL_BASE}/${USER}/labels`,
    accessToken,
    body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return String(created.id ?? "");
}

async function modify(accessToken: string, messageId: string, add: string[], remove: string[]): Promise<void> {
  await googleJson({
    method: "POST",
    url: `${GMAIL_BASE}/${USER}/messages/${encodeURIComponent(messageId)}/modify`,
    accessToken,
    body: { addLabelIds: add, removeLabelIds: remove },
  });
}

export const addLabels = (accessToken: string, messageId: string, labelIds: string[]) => modify(accessToken, messageId, labelIds, []);
export const markRead = (accessToken: string, messageId: string) => modify(accessToken, messageId, [], ["UNREAD"]);
/** Archiver = retirer de la boîte de réception. Le message n'est ni supprimé ni caché. */
export const archiveMessage = (accessToken: string, messageId: string) => modify(accessToken, messageId, [], ["INBOX"]);

export async function trashMessage(accessToken: string, messageId: string): Promise<void> {
  await googleJson({ method: "POST", url: `${GMAIL_BASE}/${USER}/messages/${encodeURIComponent(messageId)}/trash`, accessToken });
}
