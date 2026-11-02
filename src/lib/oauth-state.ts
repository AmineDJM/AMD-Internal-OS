import crypto from "crypto";

/**
 * LE `state` ET LE PKCE D'UNE CONNEXION OAUTH — une seule implémentation pour Google et Microsoft
 * (elle était recopiée mot pour mot dans `google/oauth.ts` et `mail/oauth.ts`).
 *
 * Le `state` est **signé et daté** : sans lui, un lien de retour forgé brancherait la boîte d'un
 * attaquant sur le compte d'un collègue (CSRF de connexion, silencieux). Module pur : testable
 * sans réseau ni variables réelles.
 */

const STATE_TTL_MS = 10 * 60_000;

function hmac(payload: string): string {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dev-oauth-state";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Un `state` opaque, lié à l'utilisateur, signé, à durée de vie courte. */
export function signState(userId: string, now = Date.now()): string {
  const payload = `${userId}.${now}.${crypto.randomBytes(8).toString("base64url")}`;
  return `${Buffer.from(payload).toString("base64url")}.${hmac(payload)}`;
}

/** Rend l'identifiant d'utilisateur si — et seulement si — la signature ET la fraîcheur tiennent. */
export function verifyState(state: string | null | undefined, now = Date.now()): string | null {
  if (!state) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  let payload: string;
  try { payload = Buffer.from(encoded, "base64url").toString("utf8"); } catch { return null; }

  const expected = hmac(payload);
  // Comparaison à temps constant : une comparaison ordinaire fuit la signature, octet par octet.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const [userId, issuedRaw] = payload.split(".");
  const issued = Number(issuedRaw);
  if (!userId || !Number.isFinite(issued)) return null;
  if (now - issued > STATE_TTL_MS || issued - now > 60_000) return null; // périmé, ou daté du futur
  return userId;
}

/** Le couple PKCE : un secret gardé côté serveur, et son empreinte envoyée au fournisseur. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
