/**
 * Registre « en train d'écrire… » éphémère, en mémoire.
 *
 * Best-effort, non persisté : l'état vit dans l'instance serveur (suffisant pour
 * un déploiement mono-instance comme Render). Chaque frappe rafraîchit une
 * expiration courte ; le fil actif lit qui écrit via le polling.
 */

type ConversationTyping = Map<string, number>; // userId -> expiresAt (ms)
const registry = new Map<string, ConversationTyping>();
const TTL_MS = 6_000;

export function setTyping(conversationId: string, userId: string): void {
  let conv = registry.get(conversationId);
  if (!conv) {
    conv = new Map();
    registry.set(conversationId, conv);
  }
  conv.set(userId, Date.now() + TTL_MS);
}

/** Ids actuellement en train d'écrire dans la conversation (hors `excludeUserId`). */
export function getTyping(conversationId: string, excludeUserId: string): string[] {
  const conv = registry.get(conversationId);
  if (!conv) return [];
  const now = Date.now();
  const out: string[] = [];
  for (const [userId, expires] of conv) {
    if (expires < now) {
      conv.delete(userId);
      continue;
    }
    if (userId !== excludeUserId) out.push(userId);
  }
  return out;
}
