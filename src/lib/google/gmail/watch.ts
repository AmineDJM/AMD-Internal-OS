import { GMAIL_BASE } from "../config";
import { googleJson, GoogleApiError } from "../client";

/**
 * ADAM RESTE ÉVEILLÉ — la veille Gmail (watch + Pub/Sub) et l'historique.
 *
 * Trois vérités qui gouvernent tout ce fichier :
 *
 *   1. **Une notification n'est PAS le message.** Google pousse un `historyId`, pas un courriel.
 *      Traiter la notification comme la charge utile reviendrait à faire confiance à un message
 *      non authentifié pour décider de ce qui entre dans la mémoire du PDG. On s'en sert comme
 *      d'une SONNETTE : on va ensuite chercher l'état canonique chez Google.
 *
 *   2. **Une veille EXPIRE** (7 jours au maximum). Sans renouvellement, Adam devient sourd un
 *      matin, sans erreur, sans rien à voir dans les journaux. On la renouvelle donc bien avant
 *      l'échéance.
 *
 *   3. **L'historique se PURGE.** Un `startHistoryId` trop ancien fait répondre `404
 *      historyExpired` : ce n'est pas une panne, c'est le signal qu'il faut repartir d'une liste
 *      récente. Le client traduit déjà ce cas (`history-expired`), l'appelant doit le traiter.
 */

const USER = "users/me";

/** Google borne la veille à 7 jours ; on renouvelle à mi-parcours pour absorber une panne. */
export const WATCH_RENEW_BEFORE_MS = 36 * 60 * 60_000;

export interface WatchResult {
  historyId: string;
  expiration: Date;
}

/**
 * Arme (ou ré-arme) la veille sur la BOÎTE DE RÉCEPTION.
 *
 * `labelIds: ["INBOX"]` n'est pas une restriction de confort : sans lui, Google pousse aussi les
 * brouillons et les envois d'Adam lui-même, et le pipeline se réveille pour ses propres messages.
 */
export async function startWatch(accessToken: string, topicName: string): Promise<WatchResult> {
  const res = await googleJson<{ historyId?: string; expiration?: string }>({
    method: "POST",
    url: `${GMAIL_BASE}/${USER}/watch`,
    accessToken,
    body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
  });
  const ms = Number(res.expiration ?? 0);
  return {
    historyId: String(res.historyId ?? ""),
    // Repli à 6 jours si Google ne rend pas d'échéance : mieux vaut renouveler trop tôt que
    // découvrir la surdité après coup.
    expiration: Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(Date.now() + 6 * 86_400_000),
  };
}

export interface HistoryEntry {
  id: string;
  /** Identifiants de messages AJOUTÉS depuis le point de reprise. */
  addedMessageIds: string[];
}

export interface HistoryResult {
  entries: HistoryEntry[];
  /** Le nouveau point de reprise — à enregistrer SEULEMENT après traitement réussi. */
  historyId: string | null;
  /** L'historique était trop ancien : il faut repartir d'une liste récente. */
  expired: boolean;
}

/**
 * Rejoue l'histoire depuis `startHistoryId`.
 *
 * On ne demande QUE `messageAdded` : les autres types (étiquettes posées, messages supprimés)
 * feraient réveiller le pipeline pour des changements qui ne concernent pas la conscience d'Adam.
 * Les identifiants sont dédupliqués — Google peut rendre plusieurs entrées pour un même message.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  maxPages = 5,
): Promise<HistoryResult> {
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  let pageToken: string | undefined;
  let latest: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let res: { history?: { id?: string; messagesAdded?: { message?: { id?: string } }[] }[]; historyId?: string; nextPageToken?: string };
    try {
      res = await googleJson({
        url: `${GMAIL_BASE}/${USER}/history`,
        accessToken,
        query: { startHistoryId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: 200, pageToken },
      });
    } catch (e) {
      if (e instanceof GoogleApiError && e.kind === "history-expired") {
        return { entries: [], historyId: null, expired: true };
      }
      throw e;
    }
    for (const h of res.history ?? []) {
      const added = (h.messagesAdded ?? [])
        .map((m) => m.message?.id)
        .filter((id): id is string => Boolean(id) && !seen.has(id!));
      for (const id of added) seen.add(id);
      if (added.length) entries.push({ id: String(h.id ?? ""), addedMessageIds: added });
    }
    if (res.historyId) latest = String(res.historyId);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return { entries, historyId: latest, expired: false };
}

/** Tous les identifiants ajoutés, à plat — ce que le pipeline d'ingestion consomme réellement. */
export function addedMessageIds(result: HistoryResult): string[] {
  return [...new Set(result.entries.flatMap((e) => e.addedMessageIds))];
}
