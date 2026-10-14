import crypto from "node:crypto";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JETON DE RELANCE — la preuve qu'une personne a été arrêtée au dépôt d'une facture déjà connue.
 *
 * La relance d'un paiement est réservée à son demandeur : un tiers qui presse les Finances au nom d'un autre brouille la
 * question « qui attend ? ». La Direction ouvre UNE exception (14/10/2026) : la personne qui a voulu déposer la même
 * facture ailleurs, et que le blocage a arrêtée, peut relancer — c'est le seul geste qu'on lui propose.
 *
 * Le blocage lui remet donc un JETON signé (HMAC, secret de session du serveur), lié à ELLE, à la CIBLE précise (la
 * demande ou l'ordre qui porte la facture) et daté. L'action de relance le vérifie : un identifiant de dossier recopié
 * ne suffit pas à relancer le paiement de quelqu'un d'autre, et un jeton volé ne sert qu'à son titulaire.
 *
 * Serveur seulement (`node:crypto`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un jour : le temps de lire le message, d'appeler le fournisseur, et de revenir relancer. */
export const DUREE_JETON_MS = 24 * 3600_000;

function secret(): string {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dev-relance-facture";
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Le jeton : `<charge en base64url>.<signature>`. */
export function signerJetonRelance(userId: string, cibleType: string, cibleId: string, now = Date.now()): string {
  const payload = [userId, cibleType, cibleId, String(now)].join("|");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${hmac(payload)}`;
}

/** Le jeton tient-il, pour CETTE personne et CETTE cible, et n'est-il pas périmé ? */
export function verifierJetonRelance(
  jeton: string | null | undefined, userId: string, cibleType: string, cibleId: string, now = Date.now(),
): boolean {
  if (!jeton) return false;
  const point = jeton.lastIndexOf(".");
  if (point <= 0) return false;
  let payload: string;
  try { payload = Buffer.from(jeton.slice(0, point), "base64url").toString("utf8"); } catch { return false; }
  const attendu = hmac(payload);
  const recu = jeton.slice(point + 1);
  if (recu.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(recu), Buffer.from(attendu))) return false;
  const [u, t, c, emis] = payload.split("|");
  const quand = Number(emis);
  if (u !== userId || t !== cibleType || c !== cibleId || !Number.isFinite(quand)) return false;
  return now - quand <= DUREE_JETON_MS && quand - now <= 60_000;
}
