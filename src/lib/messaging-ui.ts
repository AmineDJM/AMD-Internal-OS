/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MESSAGERIE — LA PART PURE, celle que le NAVIGATEUR a le droit d'importer.
 *
 * `messaging.ts` est un module SERVEUR : il lit la base, signe des pièces jointes et, depuis
 * qu'il écrit les messages directs, inscrit des faits au registre — ce qui tire, à dix modules
 * de distance, le push VAPID (`web-push` → `net`, `tls`). Un composant `"use client"` qui
 * l'importait pour un simple libellé de statut faisait échouer le build de production :
 * « Module not found: Can't resolve 'net' ». Le typecheck ne le voit pas, le build en cache
 * non plus ; le serveur de déploiement, lui, part d'un dossier vide et dit non.
 *
 * Ce fichier n'importe RIEN. Il porte la présence, les statuts et l'aperçu — des fonctions et
 * des constantes. `messaging.ts` les réexporte pour le serveur ; les composants client viennent
 * ici, et `client-bundle-guard.test.ts` s'assure qu'ils n'aillent jamais plus loin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Présence dérivée du dernier battement de cœur (heartbeat) de l'utilisateur. */
export type Presence = "online" | "away" | "offline";

export function presenceOf(lastSeenAt: Date | string | null | undefined): Presence {
  if (!lastSeenAt) return "offline";
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  if (diff < 90_000) return "online"; // moins de 1 min 30
  if (diff < 10 * 60_000) return "away"; // moins de 10 min
  return "offline";
}

/** Statut de messagerie choisi manuellement (façon Teams). */
export type ChatStatus = "AVAILABLE" | "BUSY" | "DND" | "BRB" | "AWAY" | "OFFLINE";
export const CHAT_STATUSES: ChatStatus[] = ["AVAILABLE", "BUSY", "DND", "BRB", "AWAY", "OFFLINE"];
export const CHAT_STATUS_LABEL: Record<ChatStatus, string> = {
  AVAILABLE: "Disponible",
  BUSY: "Occupé",
  DND: "Ne pas déranger",
  BRB: "De retour bientôt",
  AWAY: "Absent",
  OFFLINE: "Hors ligne",
};
/** Valide et normalise un statut manuel reçu du client (ou null pour « automatique »). */
export function normalizeChatStatus(raw: string | null | undefined): ChatStatus | null {
  return raw && (CHAT_STATUSES as string[]).includes(raw) ? (raw as ChatStatus) : null;
}

/** Tronque un corps de message pour un aperçu (liste, citation, notification). */
export function preview(body: string, kind: string, hasAttachment: boolean, max = 90): string {
  if (kind === "FILE" || (!body && hasAttachment)) return "📎 Pièce jointe";
  const clean = body.replace(/\s+/g, " ").trim();
  if (!clean && hasAttachment) return "📎 Pièce jointe";
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/**
 * ─────────────────────────── QUI PEUT RETIRER UN MESSAGE ───────────────────────────
 *
 * La règle vivait à DEUX endroits qui ne disaient pas la même chose. L'action serveur
 * (`deleteMessage`) accepte trois faits : un rôle à VUE GLOBALE, l'AUTEUR du message, ou
 * quelqu'un qui GÈRE la conversation. L'écran, lui, n'en lisait que deux — `canModerate` se
 * calculait `myRole === "OWNER" || myRole === "ADMIN"` et ignorait la vue globale. Un Super
 * Admin qui n'est ni auteur ni propriétaire du groupe ne voyait donc JAMAIS le bouton que
 * l'action aurait accepté : une capacité écrite, gardée, testée — et inatteignable par
 * l'écran (§118.50).
 *
 * Les trois faits sont donc NOMMÉS ici, une fois, dans le module que le navigateur ET le
 * serveur ont le droit d'importer. Deux lectures de la même règle finissent par diverger, et
 * le symptôme est toujours l'un des deux défauts : un bouton qui refuse, ou pas de bouton là
 * où c'est permis.
 *
 * Ce qui N'entre PAS ici : de quel rôle la « vue globale » se lit. L'action passe la CHAÎNE
 * `user.role` à `hasGlobalView`, donc sans casquette secondaire ; l'écran doit lire exactement
 * la même chose. L'élargir serait une décision de permission, pas une ligne de code.
 */

/** Rôle d'un membre dans une conversation (miroir de `ConvMemberRole`, sans importer Prisma). */
export type RoleConversation = "OWNER" | "ADMIN" | "MEMBER";

/** Gère la conversation : renommer, inviter, retirer, archiver — et modérer les messages. */
export function peutGererLaConversation(role: RoleConversation | string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/** Les trois faits, et rien d'autre : qui a le droit de retirer CE message. */
export function peutRetirerUnMessage(faits: {
  /** Rôle à vue globale de l'ERP (Super Admin, Direction) — modération transverse. */
  vueGlobale: boolean;
  /** C'est mon message. */
  auteur: boolean;
  /** Je gère cette conversation (propriétaire ou administrateur du groupe). */
  gereLaConversation: boolean;
}): boolean {
  return faits.vueGlobale || faits.auteur || faits.gereLaConversation;
}
