import crypto from "crypto";

/**
 * QUI A LE DROIT DE RÉVEILLER ADAM ?
 *
 * Le point d'entrée du push Gmail est une URL PUBLIQUE : n'importe qui peut lui envoyer un POST.
 * Sans vérification, un inconnu pourrait déclencher des cycles de synchronisation à volonté
 * (déni de service par facture) ou, plus subtilement, faire croire qu'un message est arrivé.
 *
 * Deux barrières, et elles ne se remplacent pas :
 *   1. un SECRET dans l'URL d'abonnement (`?token=…`) — comparé à temps constant. Simple,
 *      efficace contre le bruit de fond d'Internet ;
 *   2. le JETON OIDC que Google joint à chaque push quand l'abonnement est configuré avec un
 *      compte de service — signature RS256 VÉRIFIÉE contre les clés publiques de Google, plus
 *      l'émetteur, l'audience, l'expiration et l'adresse du compte de service.
 *
 * La deuxième est la vraie preuve d'origine. On la vérifie pour de bon : lire les revendications
 * sans contrôler la signature reviendrait à croire un attaquant sur parole.
 *
 * Même sans push, Adam ne devient pas sourd : la réconciliation périodique rattrape tout (voir
 * `gmail/reconcile.ts`). C'est ce qui permet d'être STRICT ici sans risquer de perdre du courrier.
 */

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

interface Jwk { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string }

let cache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60_000;

async function fetchJwks(): Promise<Jwk[]> {
  if (cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS) return cache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS indisponible (${res.status})`);
  const json = (await res.json()) as { keys?: Jwk[] };
  cache = { keys: json.keys ?? [], fetchedAt: Date.now() };
  return cache.keys;
}

export interface PubSubClaims {
  iss: string;
  aud: string;
  email?: string;
  email_verified?: boolean;
  exp: number;
  iat: number;
}

export type VerifyResult =
  | { ok: true; claims: PubSubClaims }
  | { ok: false; reason: string };

/** Comparaison à temps constant — une comparaison ordinaire fuit le secret, octet par octet. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Vérifie le jeton OIDC d'un push Pub/Sub : signature, émetteur, audience, fraîcheur, compte.
 *
 * `expectedAudience` doit être exactement l'audience configurée sur l'abonnement (généralement
 * l'URL du point d'entrée). `expectedEmail`, quand il est donné, exige un compte de service
 * précis — c'est ce qui empêche un AUTRE projet Google de pousser vers notre URL.
 */
export async function verifyPubSubToken(
  authorizationHeader: string | null,
  opts: { expectedAudience?: string | null; expectedEmail?: string | null; now?: number } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const raw = (authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) return { ok: false, reason: "jeton absent" };

  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "jeton malformé" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: PubSubClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "jeton illisible" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: `algorithme refusé (${header.alg ?? "?"})` };

  let keys: Jwk[];
  try { keys = await fetchJwks(); } catch { return { ok: false, reason: "clés publiques Google indisponibles" }; }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: "clé de signature inconnue" };

  let verified = false;
  try {
    const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    verified = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(sigB64, "base64url"),
    );
  } catch {
    return { ok: false, reason: "signature invérifiable" };
  }
  if (!verified) return { ok: false, reason: "signature invalide" };

  if (!ISSUERS.has(claims.iss)) return { ok: false, reason: "émetteur inattendu" };
  if (!claims.exp || claims.exp < now) return { ok: false, reason: "jeton expiré" };
  // Une tolérance d'une minute absorbe la dérive d'horloge sans ouvrir de fenêtre utile.
  if (claims.iat && claims.iat > now + 60) return { ok: false, reason: "jeton daté du futur" };
  if (opts.expectedAudience && claims.aud !== opts.expectedAudience) return { ok: false, reason: "audience inattendue" };
  if (opts.expectedEmail && (claims.email ?? "").toLowerCase() !== opts.expectedEmail.toLowerCase()) {
    return { ok: false, reason: "compte de service inattendu" };
  }
  return { ok: true, claims };
}

export interface PubSubEnvelope {
  /** Les données du message, décodées (JSON Gmail : `{ emailAddress, historyId }`). */
  data: Record<string, unknown> | null;
  messageId: string | null;
  publishTime: string | null;
  subscription: string | null;
}

/**
 * Ouvre l'enveloppe Pub/Sub. Le contenu est un SIGNAL, pas une vérité : on n'en tire que
 * l'adresse concernée et le point d'historique, et l'on va ensuite demander à Google ce qui a
 * réellement changé. Ne lève jamais — un corps malformé doit produire un refus propre.
 */
export function parsePubSubEnvelope(body: unknown): PubSubEnvelope {
  const b = (body ?? {}) as { message?: { data?: string; messageId?: string; publishTime?: string }; subscription?: string };
  let data: Record<string, unknown> | null = null;
  if (b.message?.data) {
    try {
      data = JSON.parse(Buffer.from(b.message.data, "base64").toString("utf8")) as Record<string, unknown>;
    } catch { data = null; }
  }
  return {
    data,
    messageId: b.message?.messageId ?? null,
    publishTime: b.message?.publishTime ?? null,
    subscription: b.subscription ?? null,
  };
}
