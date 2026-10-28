import { withRetry } from "@/lib/mail/graph/throttle";
import { attendu } from "@/lib/journal";

/**
 * L'APPEL À GOOGLE — un seul endroit qui parle réseau.
 *
 * Quatre responsabilités, et elles doivent être ici plutôt que dispersées dans sept providers :
 *   • poser le jeton (jamais journalisé) ;
 *   • **respecter la limitation de débit** — Google répond 429 / 403 `rateLimitExceeded`, et
 *     insister aggrave le blocage ;
 *   • **traduire les erreurs** dans un vocabulaire que l'écran sait utiliser : « reconnectez-vous »
 *     et « réessayez dans deux secondes » n'appellent pas la même conduite ;
 *   • **ne jamais rejouer une écriture** sur un 5xx — rejouer `messages/send` expédierait le
 *     message deux fois au destinataire, ce qui ne se rattrape pas.
 *
 * La stratégie de rejeu est celle, déjà éprouvée et testée, de la messagerie Microsoft
 * (`lib/mail/graph/throttle.ts`) : un module pur, sans rien de spécifique à Graph.
 */

export type GoogleErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "throttled"
  | "invalid"
  | "history-expired"
  | "network"
  | "unknown";

const HUMAN: Record<GoogleErrorKind, string> = {
  unauthorized: "Le compte Google d'Adam doit être reconnecté.",
  forbidden: "Google refuse cette action : une autorisation manque sur le compte.",
  "not-found": "Cet élément n'existe plus chez Google.",
  throttled: "Google limite temporairement les requêtes. Réessayez dans un instant.",
  invalid: "Google a refusé la requête (paramètre invalide).",
  "history-expired": "L'historique Gmail est trop ancien : une resynchronisation complète est nécessaire.",
  network: "Google est momentanément injoignable.",
  unknown: "Google n'a pas pu répondre.",
};

export class GoogleApiError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status: number;
  readonly reason: string;

  constructor(kind: GoogleErrorKind, status: number, reason: string) {
    super(HUMAN[kind]);
    this.name = "GoogleApiError";
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

function kindOf(status: number, reason: string): GoogleErrorKind {
  // 404 sur `history.list` avec un `startHistoryId` trop ancien : Google a purgé l'historique.
  // Ce n'est pas une panne — c'est le signal qu'il faut repartir d'une liste complète.
  if (status === 404 && reason === "historyExpired") return "history-expired";
  if (status === 401) return "unauthorized";
  if (status === 403) {
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" ? "throttled" : "forbidden";
  }
  if (status === 404) return "not-found";
  if (status === 429) return "throttled";
  if (status === 400) return "invalid";
  if (status >= 500) return "network";
  return "unknown";
}

export interface GoogleRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** URL ABSOLUE d'une API Google (les bases vivent dans `config.ts`). */
  url: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Corps déjà encodé (envoi RFC 822 en `message/rfc822`, téléversement Drive…). */
  rawBody?: { contentType: string; data: string | Buffer };
  accessToken: string;
}

const WRITES = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const ALLOWED_HOSTS = new Set([
  "gmail.googleapis.com",
  "www.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
  "slides.googleapis.com",
  "people.googleapis.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
]);

/**
 * L'opération, NOMMÉE pour un journal — `POST /gmail/v1/users/me/messages/{id}/send`.
 * Les identifiants sont masqués : ils rendraient le journal illisible et masqueraient
 * l'information utile, qui est QUELLE opération a échoué. Aucun paramètre de requête n'entre ici :
 * un `q=` Gmail porte les mots cherchés par la personne.
 */
export function operationOf(req: GoogleRequest): string {
  let path: string;
  try { path = new URL(req.url).pathname; } catch { path = req.url; }
  const masked = path.split("/").map((seg) => (seg.length > 24 ? "{id}" : seg)).join("/");
  return `${req.method ?? "GET"} ${masked}`;
}

function buildUrl(req: GoogleRequest): string {
  let url: URL;
  try { url = new URL(req.url); } catch { throw new GoogleApiError("invalid", 0, "badUrl"); }
  // On refuse tout hôte non Google : accepter une URL arbitraire transformerait cette fonction
  // en relais ouvert, capable d'appeler n'importe quel service AVEC le jeton d'Adam (SSRF).
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new GoogleApiError("invalid", 0, "forbiddenHost");
  }
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function parseError(status: number, text: string): GoogleApiError {
  let reason = "";
  try {
    const j = JSON.parse(text) as { error?: { status?: string; errors?: { reason?: string }[]; message?: string } };
    reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? "";
  } catch { /* corps non-JSON : le statut suffit */ }
  return new GoogleApiError(kindOf(status, reason), status, reason);
}

/**
 * Le JOURNAL — assaini par construction, pas par vigilance. Ce qui entre : l'opération, le statut,
 * le motif Google. Ce qui n'y entre JAMAIS : le jeton, le corps du message, les destinataires,
 * les paramètres de requête. La fonction ne reçoit rien d'autre.
 */
function logGoogle(ok: boolean, operation: string, status: number, reason: string): void {
  const line = { operation, status, reason: reason || null };
  if (ok) console.info("[google] ok", line);
  else console.error("[google] échec", line);
}

async function call(req: GoogleRequest): Promise<{ status: number; text: string; headers: Headers } > {
  const url = buildUrl(req);
  const method = req.method ?? "GET";
  const headers: Record<string, string> = { authorization: `Bearer ${req.accessToken}` };
  let body: string | Buffer | undefined;
  if (req.rawBody) {
    headers["content-type"] = req.rawBody.contentType;
    body = req.rawBody.data;
  } else if (req.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.body);
  }

  const out = await withRetry(async () => {
    try {
      const res = await fetch(url, { method, headers, body: body as BodyInit | undefined });
      const text = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      return { status: res.status, retryAfter: res.headers.get("retry-after"), res, text };
    } catch {
      // Panne réseau : présentée comme un 503, donc réessayable, plutôt qu'une exception brute.
      return { status: 503, retryAfter: null, res: null as Response | null, text: "" };
    }
    // Une écriture n'est PAS rejouée sur 5xx : Google a peut-être traité la requête avant de
    // tomber, et rejouer un envoi expédierait le message deux fois.
  }, { idempotent: !WRITES.has(method) });

  if (!out.res) {
    logGoogle(false, operationOf(req), 0, "network");
    throw new GoogleApiError("network", 0, "network");
  }
  if (!out.res.ok) {
    const err = parseError(out.status, out.text);
    logGoogle(false, operationOf(req), err.status, err.reason);
    throw err;
  }
  if (WRITES.has(method)) logGoogle(true, operationOf(req), out.status, "");
  return { status: out.status, text: out.text, headers: out.res.headers };
}

/** Appelle Google et rend le JSON (objet vide sur `204 No Content`). */
export async function googleJson<T = Record<string, unknown>>(req: GoogleRequest): Promise<T> {
  const { status, text } = await call(req);
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch {
    throw new GoogleApiError("unknown", status, "unparseable");
  }
}

/** Appelle Google et rend les octets — pièces jointes, export de fichiers Drive. */
export async function googleBinary(req: GoogleRequest): Promise<{ buffer: Buffer; contentType: string }> {
  const url = buildUrl(req);
  const out = await withRetry(async () => {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${req.accessToken}` } });
      return { status: res.status, retryAfter: res.headers.get("retry-after"), res };
    } catch {
      return { status: 503, retryAfter: null, res: null as Response | null };
    }
  });
  if (!out.res) throw new GoogleApiError("network", 0, "network");
  if (!out.res.ok) {
    const err = parseError(out.status, await out.res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", "")));
    logGoogle(false, operationOf(req), err.status, err.reason);
    throw err;
  }
  return {
    buffer: Buffer.from(await out.res.arrayBuffer()),
    contentType: out.res.headers.get("content-type") ?? "application/octet-stream",
  };
}
