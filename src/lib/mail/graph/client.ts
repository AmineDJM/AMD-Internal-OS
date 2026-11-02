import { GRAPH_BASE } from "../config";
import { MailError, type MailErrorKind, type MailDiagnostic } from "../provider";
import { withRetry } from "./throttle";
import { attendu } from "@/lib/journal";

/**
 * L'APPEL À GRAPH — un seul endroit qui parle réseau.
 *
 * Quatre responsabilités, et elles doivent être ici plutôt que dispersées :
 *   • poser le jeton (jamais journalisé) ;
 *   • **respecter la limitation de débit** — Graph répond 429 quand on va trop vite, et insister
 *     aggrave le blocage ;
 *   • **traduire les erreurs** dans un vocabulaire que l'écran sait utiliser. Sans cette
 *     traduction, l'interface affiche le même message pour « reconnectez-vous » et pour
 *     « réessayez dans deux secondes » — donc le mauvais une fois sur deux ;
 *   • **rendre les écritures traçables**. Un message qui ne part pas est le pire cas d'une
 *     messagerie : personne ne s'en aperçoit. Sans journal, on ne peut même pas savoir si Microsoft
 *     a accepté. Le journal ci-dessous existe précisément pour ça.
 */

/** Le code d'erreur Graph qui signale un jeton de delta périmé — il faut resynchroniser. */
const DELTA_EXPIRED = new Set(["syncStateNotFound", "resyncRequired"]);

function kindOf(status: number, code: string): MailErrorKind {
  if (DELTA_EXPIRED.has(code)) return "delta-expired";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "throttled";
  if (status >= 500) return "network";
  return "unknown";
}

const HUMAN: Record<MailErrorKind, string> = {
  unauthorized: "Votre boîte Microsoft doit être reconnectée.",
  forbidden: "Microsoft refuse cette action : une autorisation manque sur votre compte.",
  "not-found": "Cet élément n'existe plus dans votre boîte.",
  throttled: "Microsoft limite temporairement les requêtes. Réessayez dans un instant.",
  "delta-expired": "La synchronisation doit repartir de zéro.",
  network: "Microsoft est momentanément injoignable.",
  unknown: "La messagerie n'a pas pu répondre.",
};

export interface GraphRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Chemin relatif à `/v1.0`, ex. `/me/mailFolders`. Une URL absolue n'est jamais acceptée. */
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  accessToken: string;
}

/**
 * L'OPÉRATION, NOMMÉE POUR UN JOURNAL — `POST /me/messages/{id}/send`.
 *
 * Les identifiants de message de Graph font cent cinquante caractères : les laisser rendrait le
 * journal illisible et masquerait l'information utile, qui est **quelle opération** a échoué. Le
 * paramètre de requête, lui, n'entre jamais ici : un `$search` porte les mots cherchés par la
 * personne, un `$filter` porte un identifiant de conversation.
 */
export function operationOf(req: GraphRequest): string {
  const path = req.path
    .split("/")
    .map((seg) => (seg.length > 24 ? "{id}" : seg))
    .join("/");
  return `${req.method ?? "GET"} ${path.startsWith("/") ? path : `/${path}`}`;
}

/** L'identifiant de corrélation Microsoft — le seul élément qu'un support Microsoft sait tracer. */
function correlationId(res: Response | null): string | null {
  return res?.headers.get("request-id") ?? res?.headers.get("client-request-id") ?? null;
}

/**
 * LE JOURNAL — assaini par construction, pas par vigilance.
 *
 * Ce qui entre : l'opération, le statut, le code d'erreur Graph, la corrélation Microsoft. Ce qui
 * n'y entre JAMAIS : le jeton d'accès, le secret d'application, l'objet ou le corps du message,
 * les adresses des destinataires, les paramètres de requête. Il n'y a pas de champ libre où l'un
 * d'eux pourrait se glisser : la fonction ne reçoit que le diagnostic, qui ne les contient pas.
 */
function logGraph(ok: boolean, d: MailDiagnostic): void {
  const line = { operation: d.operation, status: d.status, code: d.code || null, requestId: d.requestId };
  if (ok) console.info("[ms-graph] ok", line);
  else console.error("[ms-graph] échec", line);
}

/** Une écriture se trace toujours ; une lecture, seulement quand elle échoue — sinon on noie tout. */
const WRITES = new Set(["POST", "PATCH", "DELETE"]);

function buildUrl(path: string, query?: GraphRequest["query"]): string {
  // On refuse une URL absolue : accepter `https://…` transformerait cette fonction en relais
  // ouvert, capable d'appeler n'importe quel service avec le jeton de la personne.
  if (/^https?:/i.test(path)) throw new MailError("unknown", "Chemin Graph invalide.");
  const url = new URL(GRAPH_BASE + (path.startsWith("/") ? path : `/${path}`));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Appelle Graph et rend le JSON. Lève une `MailError` parlante en cas d'échec. */
export async function graphJson<T = Record<string, unknown>>(req: GraphRequest): Promise<T> {
  const { res, text } = await graphRaw(req);
  // `202 Accepted` sur un envoi rend un corps VIDE. Ce n'est pas une anomalie : c'est la réponse
  // normale de Graph quand il prend le message en charge. On la traite comme un succès plein.
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch {
    throw new MailError("unknown", `Réponse illisible de Microsoft (${res.status}).`, undefined, {
      status: res.status, code: "", requestId: correlationId(res), operation: operationOf(req),
    });
  }
}

/** Appelle Graph et rend les octets — pièces jointes. */
export async function graphBinary(req: GraphRequest): Promise<{ buffer: Buffer; contentType: string }> {
  const url = buildUrl(req.path, req.query);
  const out = await withRetry(async () => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${req.accessToken}` } });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), res };
  });
  if (!out.res.ok) throw await toError(out.res, undefined, req);
  return {
    buffer: Buffer.from(await out.res.arrayBuffer()),
    contentType: out.res.headers.get("content-type") ?? "application/octet-stream",
  };
}

async function graphRaw(req: GraphRequest): Promise<{ res: Response; text: string }> {
  const url = buildUrl(req.path, req.query);
  const method = req.method ?? "GET";
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${req.accessToken}`,
      ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  };

  const out = await withRetry(async () => {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      // Panne réseau : on la présente comme un 503, donc réessayable, plutôt que de faire
      // remonter une exception brute jusqu'à l'écran.
      return { status: 503, retryAfter: null, res: null as Response | null, text: "" };
    }
    const text = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
    return { status: res.status, retryAfter: res.headers.get("retry-after"), res, text };
  // Une écriture n'est PAS rejouée sur 5xx : Graph a peut-être traité la requête avant de tomber,
  // et rejouer un envoi expédierait le message deux fois au destinataire.
  }, { idempotent: !WRITES.has(method) });

  if (!out.res) {
    const diagnostic: MailDiagnostic = {
      status: 0, code: "network", requestId: null, operation: operationOf(req),
    };
    logGraph(false, diagnostic);
    throw new MailError("network", HUMAN.network, undefined, diagnostic);
  }
  if (!out.res.ok) throw await toError(out.res, out.text, req);
  if (WRITES.has(method)) {
    logGraph(true, { status: out.res.status, code: "", requestId: correlationId(out.res), operation: operationOf(req) });
  }
  return { res: out.res, text: out.text };
}

async function toError(res: Response, bodyText: string | undefined, req: GraphRequest): Promise<MailError> {
  const text = bodyText ?? (await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", "")));
  let code = "";
  let graphMessage = "";
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = j.error?.code ?? "";
    graphMessage = typeof j.error?.message === "string" ? j.error.message : "";
  } catch { /* corps non-JSON : on se contente du statut */ }
  const kind = kindOf(res.status, code);
  const retryAfter = Number(res.headers.get("retry-after"));
  // Le CODE de Graph est conservé à part : il nomme la cause (`MailboxNotEnabledForRESTAPI`,
  // `ErrorInvalidRecipients`…) là où le message français ne fait que la catégoriser. Le CORPS,
  // lui, est jeté : il peut recopier l'objet du message ou l'adresse d'un destinataire.
  const diagnostic: MailDiagnostic = {
    status: res.status, code, requestId: correlationId(res), operation: operationOf(req),
  };
  logGraph(false, diagnostic);
  // EXCEPTION étroite : le message de Graph, sur un 400 de LECTURE seulement. Un `code` seul dit
  // « BadRequest » sans dire QUOI ; le message, lui, nomme la faute (« Could not find a property
  // named 'x' ») — sans lui, un paramètre invalide est indiagnosticable depuis le journal. La
  // restriction aux lectures n'est pas décorative : sur une écriture, ce même champ recopie
  // l'adresse d'un destinataire refusé, qui n'a rien à faire dans un journal. Jamais montré à
  // l'utilisateur.
  if (res.status === 400 && (req.method ?? "GET") === "GET" && graphMessage) {
    console.error("[ms-graph] requête invalide", { operation: operationOf(req), detail: graphMessage.slice(0, 200) });
  }
  return new MailError(kind, HUMAN[kind], Number.isFinite(retryAfter) ? retryAfter : undefined, diagnostic);
}
