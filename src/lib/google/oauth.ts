import crypto from "crypto";
import {
  GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPE_STRING,
  type GoogleConfig,
} from "./config";
import { sansBloquer } from "@/lib/journal";

/**
 * L'AUTHENTIFICATION GOOGLE D'ADAM — code d'autorisation + PKCE, accès HORS LIGNE.
 *
 * Hors ligne (`access_type=offline`) parce qu'Adam doit rester vivant quand personne n'est
 * connecté : sans jeton de rafraîchissement, la boîte se coupe à la première heure écoulée et le
 * Chief redevient un chatbot qu'il faut réveiller à la main.
 *
 * Le `state` est **signé et daté** : sans lui, un lien de retour forgé permettrait de brancher la
 * boîte d'un attaquant sur le compte du PDG — qui lirait alors les messages de l'attaquant et,
 * surtout, enverrait en son nom. C'est le CSRF de connexion, et il est silencieux.
 *
 * Module PUR côté logique (state, PKCE, URL) : testable sans réseau ni variables réelles.
 */

const STATE_TTL_MS = 10 * 60_000;

function hmac(payload: string): string {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dev-google-state";
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

/** Le couple PKCE : un secret gardé côté serveur, et son empreinte envoyée à Google. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * L'URL vers laquelle envoyer la personne pour qu'elle accepte (ou refuse).
 *
 * `prompt=consent` n'est pas décoratif : Google ne rend un jeton de RAFRAÎCHISSEMENT que la
 * première fois qu'un compte accepte une application. Une reconnexion sans lui rendrait un accès
 * qui expire en une heure, sans rien pour le renouveler — et la panne n'apparaîtrait que le
 * lendemain, sans cause visible.
 */
export function buildAuthorizeUrl(cfg: GoogleConfig, state: string, challenge: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: GOOGLE_SCOPE_STRING,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  const hint = loginHint || cfg.adamEmail;
  if (hint) p.set("login_hint", hint);
  return `${GOOGLE_AUTHORIZE_URL}?${p.toString()}`;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string;
  /** `id_token` brut quand Google le rend — sert à lire l'adresse sans appel supplémentaire. */
  idToken: string | null;
}

function toTokenSet(json: Record<string, unknown>): GoogleTokenSet {
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken: String(json.access_token ?? ""),
    refreshToken: json.refresh_token ? String(json.refresh_token) : null,
    // On retire 60 s : un jeton qui expire pendant le vol d'une requête produit une erreur
    // incompréhensible côté utilisateur.
    expiresAt: new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000),
    scopes: String(json.scope ?? ""),
    idToken: json.id_token ? String(json.id_token) : null,
  };
}

/**
 * LE REFUS DE GOOGLE, PORTÉ PAR L'ERREUR — pas seulement raconté dans son message.
 *
 * Le `error` de Google (`invalid_grant`, `invalid_client`…) nomme la cause là où un message
 * traduit ne fait que la catégoriser. `error_description` est délibérément ignorée : elle peut
 * recopier des éléments de la requête, et une erreur se retrouve dans les journaux.
 */
export class GoogleAuthError extends Error {
  readonly providerCode: string;
  readonly httpStatus: number;

  constructor(providerCode: string, httpStatus: number) {
    super(`Google a refusé l'authentification (${providerCode}).`);
    this.name = "GoogleAuthError";
    this.providerCode = providerCode;
    this.httpStatus = httpStatus;
  }
}

async function postToken(body: URLSearchParams): Promise<GoogleTokenSet> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(sansBloquer("oauth.postToken.json", {}))) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    throw new GoogleAuthError(String(json.error ?? res.status), res.status);
  }
  return toTokenSet(json);
}

export function exchangeCode(cfg: GoogleConfig, code: string, verifier: string): Promise<GoogleTokenSet> {
  return postToken(new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  }));
}

export function refreshTokens(cfg: GoogleConfig, refreshToken: string): Promise<GoogleTokenSet> {
  return postToken(new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }));
}

/**
 * RÉVOQUE le consentement chez Google. Se déconnecter doit vraiment déconnecter : effacer nos
 * jetons sans révoquer laisserait l'autorisation vivante côté Google, invisible depuis l'ERP.
 * Ne lève jamais — une révocation impossible ne doit pas empêcher d'effacer les jetons ici.
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Lit la charge utile d'un `id_token` SANS vérifier sa signature.
 *
 * Acceptable ICI, et nulle part ailleurs : le jeton vient d'être obtenu par un échange direct
 * avec Google, sur une connexion TLS, contre notre secret d'application — il n'a pas transité par
 * le navigateur. On ne s'en sert que pour AFFICHER l'adresse connectée ; l'autorité reste le
 * jeton d'accès lui-même. Ne jamais utiliser cette fonction sur un jeton reçu d'un client.
 */
export function readIdTokenClaims(idToken: string | null): { email: string | null; name: string | null; sub: string | null } {
  if (!idToken) return { email: null, name: null, sub: null };
  const parts = idToken.split(".");
  if (parts.length < 2) return { email: null, name: null, sub: null };
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
      name: typeof claims.name === "string" ? claims.name : null,
      sub: typeof claims.sub === "string" ? claims.sub : null,
    };
  } catch {
    return { email: null, name: null, sub: null };
  }
}
