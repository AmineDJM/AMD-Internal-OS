import { createHash, createHmac } from "crypto";
import { resolveS3Config, type S3Config } from "@/lib/storage/s3-config";
import { sansBloquer, attendu } from "@/lib/journal";
import { noterEffetExterne } from "@/lib/effets/magasin";

/** LE PORT DE SIMULATION (J7) : un geste simulé note l'écriture au stockage et ne touche pas au bucket. */
const stockageSimule = (operation: string, key: string, taille?: number): boolean =>
  noterEffetExterne({ acte: "STOCKAGE", cible: key, apercu: taille !== undefined ? `${operation} · ${taille} octets` : operation, origine: "object-storage" });

/**
 * STOCKAGE OBJET S3-COMPATIBLE — Supabase Storage, Cloudflare R2, AWS S3, MinIO, Backblaze…
 *
 * SANS dépendance SDK : les signatures **AWS SigV4** sont faites à la main avec le crypto natif.
 * C'est ce qui rend la couche réellement générique — il n'y a pas de client propriétaire à
 * remplacer pour changer de fournisseur, seulement des variables d'environnement.
 *
 * Deux usages, et ils comptent tous les deux :
 *   • le navigateur téléverse un dossier CTD DIRECTEMENT vers le bucket via une URL présignée —
 *     ni le serveur ni Postgres ne voient passer les octets, ce qui autorise des archives de
 *     plusieurs centaines de méga-octets ;
 *   • le serveur lit et écrit des objets (blobs chiffrés, inspection d'archive).
 *
 * Non configuré → l'application retombe sur le stockage en base, sans régression.
 *
 * Configuration : voir `@/lib/storage/s3-config` (variables `S3_*`, anciennes `REG_S3_*` en
 * repli). Les secrets restent strictement côté serveur : aucun nom en `NEXT_PUBLIC_`.
 */

function config(): S3Config | null {
  return resolveS3Config(process.env as Record<string, string | undefined>);
}

/** Le stockage objet direct est-il configuré (bucket + clés présents) ? */
export function objectStorageConfigured(): boolean {
  return config() !== null;
}

const ALGO = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

// Encodage RFC 3986 (SigV4) : espace → %20, encode aussi ! * ' ( ) que `encodeURIComponent` laisse.
function uriEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
// Chemin de ressource : chaque segment encodé, les « / » conservés.
function encodePath(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}
function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function amzDate(d: Date): { amz: string; date: string } {
  const amz = d.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  return { amz, date: amz.slice(0, 8) };
}
function signingKeyBuf(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}
function signingKey(cfg: S3Config, date: string): Buffer {
  return signingKeyBuf(cfg.secretAccessKey, date, cfg.region, SERVICE);
}
/** Dérivation de clé de signature SigV4 en hex — exposée pour test (vecteur AWS connu). */
export function _deriveSigningKeyHex(secret: string, date: string, region: string, service: string): string {
  return signingKeyBuf(secret, date, region, service).toString("hex");
}
/**
 * OÙ TAPER, EXACTEMENT — hôte + chemin de la ressource, tels qu'ils seront AUSSI signés.
 *
 * ⚠️ **Le chemin de base de l'endpoint fait partie de l'adresse.** Chez R2, AWS ou MinIO, l'endpoint
 * est un hôte nu et le chemin commence au bucket ; chez **Supabase**, l'API S3 vit sous
 * `/storage/v1/s3`, et l'ignorer envoie chaque requête à une adresse qui n'existe pas — un **404**
 * sur chaque écriture, alors que les clés, le bucket et la région sont parfaitement bons. Le
 * préfixe est donc conservé tel quel, et il entre dans la requête canonique comme dans l'URL
 * appelée : les deux doivent coïncider, sinon la signature est rejetée.
 *
 * Fonction PURE — testée sur les deux formes d'endpoint.
 */
export function hostAndPath(cfg: S3Config, key: string): { protocol: string; host: string; resourcePath: string } {
  const base = new URL(cfg.endpoint);
  const host = cfg.pathStyle ? base.host : `${cfg.bucket}.${base.host}`;
  // `new URL("https://h").pathname` vaut « / » : on le ramène à la chaîne vide pour ne pas
  // fabriquer un double séparateur, qui ne serait pas la même ressource pour S3.
  const basePath = base.pathname.replace(/\/+$/, "");
  const resourcePath = cfg.pathStyle
    ? `${basePath}/${cfg.bucket}/${encodePath(key)}`
    : `${basePath}/${encodePath(key)}`;
  return { protocol: base.protocol, host, resourcePath };
}

/**
 * URL PRÉSIGNÉE pour un PUT (téléversement direct navigateur → bucket). Signature par query string,
 * `UNSIGNED-PAYLOAD`, seul l'en-tête `host` signé → le navigateur envoie juste le corps. Null si non configuré.
 */
export function presignPutUrl(key: string, expiresSec = 3600, extraQuery: Record<string, string> = {}): string | null {
  return presign("PUT", key, expiresSec, extraQuery);
}

/**
 * URL PRÉSIGNÉE pour un GET — le navigateur TÉLÉCHARGE directement depuis le bucket. Utilisée pour
 * les gros fichiers déposés en direct : les servir par l'application les ferait passer entiers en
 * mémoire. `response-content-disposition` donne au fichier son nom (accents compris).
 */
export function presignGetUrl(key: string, expiresSec = 900, extraQuery: Record<string, string> = {}): string | null {
  return presign("GET", key, expiresSec, extraQuery);
}

function presign(method: "PUT" | "GET", key: string, expiresSec: number, extraQuery: Record<string, string>): string | null {
  const cfg = config();
  if (!cfg) return null;
  const { protocol, host, resourcePath } = hostAndPath(cfg, key);
  const { amz, date } = amzDate(new Date());
  const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;
  const params: Record<string, string> = {
    // `extraQuery` d'abord : les paramètres de l'opération (`partNumber`, `uploadId`) entrent dans
    // la requête canonique au même titre que les autres, et ne peuvent pas écraser la signature.
    ...extraQuery,
    "X-Amz-Algorithm": ALGO,
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join("&");
  const canonicalRequest = [method, resourcePath, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = [ALGO, amz, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(cfg, date)).update(stringToSign).digest("hex");
  return `${protocol}//${host}${resourcePath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * URL PRÉSIGNÉE D'UNE PARTIE — c'est elle qui permet au NAVIGATEUR de faire du multipart.
 *
 * Le serveur ouvre le téléversement et le referme ; entre les deux, le navigateur envoie les
 * parties EN PARALLÈLE, directement au bucket. Aucun octet ne transite par l'application : ni la
 * mémoire du serveur, ni sa bande passante, ni Postgres ne sont sur le chemin.
 *
 * ⚠️ Le bucket doit exposer l'en-tête `ETag` en CORS (`ExposeHeaders: ETag`) : sans lui, le
 * navigateur ne peut pas lire l'empreinte de chaque partie, et la finalisation est impossible.
 */
export function presignUploadPartUrl(key: string, uploadId: string, partNumber: number, expiresSec = 3600): string | null {
  return presignPutUrl(key, expiresSec, { partNumber: String(partNumber), uploadId });
}

/** Requête S3 signée (en-tête Authorization SigV4) — GET/PUT/DELETE côté serveur. */
async function signedRequest(method: "GET" | "PUT" | "DELETE", key: string, body?: Buffer, contentType?: string): Promise<Response> {
  const cfg = config();
  if (!cfg) throw new Error("Stockage objet non configuré.");
  const { protocol, host, resourcePath } = hostAndPath(cfg, key);
  const { amz, date } = amzDate(new Date());
  const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;
  const payloadHash = body ? sha256hex(body) : EMPTY_SHA256;
  // On ne signe QUE host + content-sha256 + date : le content-type éventuel reste non signé
  // (accepté tel quel par S3/R2) → moins de surface d'erreur de signature.
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const canonicalRequest = [method, resourcePath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [ALGO, amz, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(cfg, date)).update(stringToSign).digest("hex");
  const authorization = `${ALGO} Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": amz, authorization };
  if (contentType) headers["content-type"] = contentType;
  // `host` est ajouté automatiquement par le client HTTP (et signé ci-dessus).
  return fetch(`${protocol}//${host}${resourcePath}`, { method, headers, body });
}

// Extrait le code d'erreur S3/R2 (`<Code>…</Code>`) du corps XML pour un diagnostic précis.
function s3ErrorCode(body: string): string {
  const m = /<Code>([^<]+)<\/Code>/.exec(body);
  return m ? m[1] : "";
}

/**
 * Requête signée AVEC query string — nécessaire au téléversement en plusieurs parties, dont
 * chaque opération se distingue par un paramètre (`?uploads`, `?partNumber=…&uploadId=…`).
 * Le chemin PUT/GET/DELETE simple garde sa propre fonction, éprouvée : on n'y touche pas.
 */
async function signedRequestQ(
  method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE",
  key: string,
  query: Record<string, string>,
  body?: Buffer,
  contentType?: string,
  enTetesNonSignes?: Record<string, string>,
): Promise<Response> {
  const cfg = config();
  if (!cfg) throw new Error("Stockage objet non configuré.");
  const { protocol, host, resourcePath } = hostAndPath(cfg, key);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const payloadHash = body ? sha256hex(body) : EMPTY_SHA256;
  const headers = signAuthHeaders(cfg, method, host, resourcePath, canonicalQuery, payloadHash);
  if (contentType) headers["content-type"] = contentType;
  // Non signés (comme `content-type`) : `Range` ne change pas l'identité de la requête, et S3/R2 l'acceptent.
  if (enTetesNonSignes) Object.assign(headers, enTetesNonSignes);
  const url = `${protocol}//${host}${resourcePath}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return fetch(url, { method, headers, body });
}

const tagOf = (xml: string, tag: string): string => {
  const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return m ? m[1] : "";
};

/**
 * TÉLÉVERSEMENT EN PLUSIEURS PARTIES — c'est ce qui permet d'écrire une archive d'un gigaoctet
 * sans jamais la tenir en mémoire.
 *
 * L'alternative (un PUT unique) oblige à charger tout le contenu dans un Buffer : sur un
 * hébergeur à mémoire bornée, un dossier CTD volumineux fait tomber le processus — et ce n'est
 * pas une panne qu'on diagnostique facilement, puisqu'elle dépend de la taille du fichier envoyé.
 *
 * Le protocole S3 impose au moins 5 Mio par partie (sauf la dernière) ; on en prend 16 pour rester
 * loin de la borne et limiter le nombre d'allers-retours.
 */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;

/** Seuil au-delà duquel on passe en plusieurs parties. En deçà, un PUT simple est plus rapide. */
export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;

/**
 * COMBIEN DE PARTIES EN VOL À LA FOIS.
 *
 * Envoyées une par une, les parties additionnent leurs allers-retours : sur une liaison où un
 * aller-retour coûte 200 ms, un fichier de 500 Mo paie 31 attentes en série pour rien — le débit
 * disponible n'est jamais utilisé. Quatre parties en vol saturent le lien sans faire exploser la
 * mémoire (le pic vaut `concurrence × 16 Mio`).
 */
export const MULTIPART_CONCURRENCY = (() => {
  const n = Number(process.env.S3_UPLOAD_CONCURRENCY ?? 4);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 16) : 4;
})();

/**
 * Envoie les parties avec au plus `limit` requêtes en vol, et rend leurs ETags **dans l'ordre des
 * numéros de partie** — c'est cet ordre, pas celui des réponses, qui recolle le fichier.
 *
 * L'envoi est confié à `send` : la stratégie de parallélisme se teste ainsi sans réseau.
 *
 * À la première erreur on cesse de lire la source, mais on attend les parties déjà en vol avant de
 * relever l'erreur : les abandonner laisserait des requêtes en cours pendant qu'on annule le
 * téléversement, et le `AbortMultipartUpload` pourrait passer AVANT elles — laissant justement les
 * parties orphelines qu'il devait supprimer.
 */
export async function uploadPartsBounded(
  parts: AsyncIterable<Buffer>,
  send: (partNumber: number, body: Buffer) => Promise<string>,
  limit = MULTIPART_CONCURRENCY,
): Promise<string[]> {
  const etags: string[] = [];
  const active = new Map<number, Promise<number>>();
  let failure: unknown = null;
  let n = 0;

  for await (const part of parts) {
    if (failure) break;
    const partNumber = ++n;
    active.set(partNumber, (async () => {
      try { etags[partNumber - 1] = await send(partNumber, part); }
      catch (err) { failure ??= err; }
      return partNumber;
    })());
    if (active.size >= Math.max(1, limit)) active.delete(await Promise.race(active.values()));
  }
  await Promise.all(active.values());
  if (failure) throw failure;
  return etags;
}

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  if (stockageSimule("ouverture d'un dépôt en parties", key)) return "simulation";
  const res = await signedRequestQ("POST", key, { uploads: "" }, undefined, contentType);
  const xml = await res.text();
  if (!res.ok) throw new Error(`Ouverture du téléversement échouée (${res.status}${s3ErrorCode(xml) ? ` ${s3ErrorCode(xml)}` : ""}).`);
  const uploadId = tagOf(xml, "UploadId");
  if (!uploadId) throw new Error("Le stockage n'a pas renvoyé d'identifiant de téléversement.");
  return uploadId;
}

async function uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
  const res = await signedRequestQ("PUT", key, { partNumber: String(partNumber), uploadId }, body);
  if (!res.ok) {
    const detail = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
    throw new Error(`Envoi de la partie ${partNumber} échoué (${res.status}${s3ErrorCode(detail) ? ` ${s3ErrorCode(detail)}` : ""}).`);
  }
  // L'ETag est indispensable à la finalisation : sans lui, S3 refuse de recoller les parties.
  const etag = res.headers.get("etag") ?? res.headers.get("ETag") ?? "";
  if (!etag) throw new Error(`Le stockage n'a pas renvoyé d'ETag pour la partie ${partNumber}.`);
  return etag;
}

export async function completeMultipartUpload(key: string, uploadId: string, etags: string[]): Promise<void> {
  if (stockageSimule("dépôt en parties", key)) return;
  const body = Buffer.from(
    `<CompleteMultipartUpload>${etags
      .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`,
    "utf8",
  );
  const res = await signedRequestQ("POST", key, { uploadId }, body, "application/xml");
  const xml = await res.text();
  // Piège S3 : la finalisation peut répondre 200 AVEC une erreur dans le corps. Ne pas la lire,
  // c'est croire un téléversement réussi alors que l'objet n'existe pas.
  if (!res.ok || /<Error>/.test(xml)) {
    throw new Error(`Finalisation du téléversement échouée (${res.status}${s3ErrorCode(xml) ? ` ${s3ErrorCode(xml)}` : ""}).`);
  }
}

/** Abandonne un téléversement entamé — libère les parties déjà envoyées. Ne lève jamais. */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  if (stockageSimule("abandon d'un dépôt", key)) return;
  try {
    await signedRequestQ("DELETE", key, { uploadId });
  } catch (err) {
    console.error("[object-storage] abandon du téléversement", key, err instanceof Error ? err.message : err);
  }
}

/**
 * Écrit un objet depuis un FLUX, sans jamais le tenir entier en mémoire.
 *
 * Le pic mémoire vaut une partie (16 Mio), quelle que soit la taille du contenu. En cas d'échec
 * à mi-parcours, le téléversement est abandonné proprement : on ne laisse pas des parties
 * orphelines facturées dans le bucket, et surtout on ne laisse pas croire à un succès.
 */
export async function putObjectStream(
  key: string,
  source: AsyncIterable<Buffer>,
  contentType = "application/octet-stream",
): Promise<void> {
  if (stockageSimule("dépôt en parties", key)) {
    for await (const _partie of source) { /* consommée : la source ne reste pas suspendue */ }
    return;
  }
  const uploadId = await createMultipartUpload(key, contentType);
  try {
    const etags = await uploadPartsBounded(
      intoParts(source, MULTIPART_PART_BYTES),
      (partNumber, body) => uploadPart(key, uploadId, partNumber, body),
    );
    await completeMultipartUpload(key, uploadId, etags);
  } catch (err) {
    await abortMultipartUpload(key, uploadId);
    throw err;
  }
}

/**
 * Regroupe un flux de morceaux quelconques en PARTIES de taille fixe — sauf la dernière.
 *
 * C'est la règle du protocole, et elle n'est pas cosmétique : S3 refuse toute partie non finale
 * inférieure à 5 Mio. Un chiffrement en flux rend des morceaux de tailles arbitraires ; les
 * renvoyer tels quels ferait échouer le téléversement au deuxième morceau, sur une erreur
 * (`EntityTooSmall`) qui ne dit pas d'où elle vient.
 *
 * Un flux vide rend UNE partie vide : le protocole exige au moins une partie pour finaliser.
 *
 * Générateur PUR — testé.
 */
export async function* intoParts(source: AsyncIterable<Buffer>, partSize: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let emitted = 0;

  for await (const chunk of source) {
    if (chunk.length === 0) continue;
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes >= partSize) {
      // Un seul morceau en attente : on le découpe en VUES, sans le recopier. Recopier ici rendait
      // le découpage quadratique quand la source rend un gros bloc d'un coup (un contenu déjà en
      // mémoire, par exemple) — 200 Mo se recopiaient une fois par partie.
      const whole = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      yield whole.subarray(0, partSize);
      emitted += 1;
      const tail = whole.subarray(partSize);
      pending = tail.length > 0 ? [tail] : [];
      pendingBytes = tail.length;
    }
  }
  if (pendingBytes > 0) {
    yield Buffer.concat(pending, pendingBytes);
  } else if (emitted === 0) {
    yield Buffer.alloc(0);
  }
}

/**
 * Message d'erreur qui DIT OÙ l'on a tapé.
 *
 * « Écriture de l'objet échouée (404) » n'apprend rien : on cherche une clé révoquée, un bucket
 * plein, un réseau coupé — alors que l'adresse elle-même était fausse. Le chemin visé lève
 * l'ambiguïté en un coup d'œil ; il ne contient ni clé ni signature.
 */
function s3Failure(action: string, res: Response, key: string, detail: string): Error {
  const code = s3ErrorCode(detail);
  let where = "";
  try { where = ` sur ${hostAndPath(config()!, key).resourcePath}`; } catch { /* config lue ailleurs */ }
  const hint = res.status === 404
    ? " Un 404 signale une ADRESSE inexistante, pas un problème de clé : vérifiez que S3_ENDPOINT"
      + " porte bien le chemin de l'API S3 du fournisseur (Supabase : /storage/v1/s3) et que le bucket existe."
    : "";
  return new Error(`${action} échouée (${res.status}${code ? ` ${code}` : ""})${where}.${hint}`);
}

/** Écrit un objet (le serveur pousse les octets vers le bucket — ex. blobs chiffrés). */
export async function putObject(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
  if (stockageSimule("dépôt", key, body.length)) return;
  const res = await signedRequest("PUT", key, body, contentType);
  if (!res.ok) throw s3Failure("Écriture de l'objet", res, key, await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", "")));
}

/** Lit un objet en mémoire (inspection d'archive après PUT direct, ou lecture d'un blob). */
export async function getObject(key: string): Promise<Buffer> {
  const res = await signedRequest("GET", key);
  if (!res.ok) throw s3Failure("Lecture de l'objet", res, key, await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", "")));
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Lit une PLAGE d'un objet (`Range: bytes=debut-fin`) — c'est ce qui permet de parcourir une archive
 * de plusieurs gigaoctets en ne lisant que son répertoire et l'entrée demandée.
 */
export async function getObjectRange(key: string, debut: number, longueur: number): Promise<Buffer> {
  if (longueur <= 0) return Buffer.alloc(0);
  const res = await signedRequestQ("GET", key, {}, undefined, undefined, { range: `bytes=${debut}-${debut + longueur - 1}` });
  if (!res.ok) throw s3Failure("Lecture d'une plage de l'objet", res, key, await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", "")));
  return Buffer.from(await res.arrayBuffer());
}

/** Supprime un objet (nettoyage archive temporaire ou blob déréférencé). Ne lève jamais. */
export async function deleteObject(key: string): Promise<void> {
  if (stockageSimule("suppression", key)) return;
  try {
    const res = await signedRequest("DELETE", key);
    if (!res.ok && res.status !== 404) console.error("[reg-object-storage] delete", key, res.status);
  } catch (err) {
    console.error("[reg-object-storage] delete", key, err instanceof Error ? err.message : err);
  }
}

/** Extrait les noms de bucket (`<Name>…</Name>`) d'une réponse S3 ListBuckets. Exporté pour test.
 *  `<DisplayName>` du propriétaire n'est PAS capturé (le tag n'est pas `<Name>`). */
export function parseBucketNames(xml: string): string[] {
  const names: string[] = [];
  const re = /<Name>([^<]+)<\/Name>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) names.push(m[1]);
  return names;
}

/** Hôte de l'endpoint configuré (ex. `abcd.storage.supabase.co`) — pour diagnostic (non sensible). */
export function configuredEndpointHost(): string {
  const cfg = config();
  if (!cfg) return "";
  try { return new URL(cfg.endpoint).host; } catch { return ""; }
}

/** Calcule les en-têtes signés SigV4 (date/content-sha256/authorization) pour une requête à un
 *  hôte + chemin + querystring canonique donnés. Réservé aux sondes de diagnostic (host variable).
 *  N'altère pas le chemin PUT/GET éprouvé (`signedRequest`), pour ne pas risquer l'upload. */
function signAuthHeaders(cfg: S3Config, method: string, host: string, resourcePath: string, canonicalQuery: string, payloadHash: string): Record<string, string> {
  const { amz, date } = amzDate(new Date());
  const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const canonicalRequest = [method, resourcePath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [ALGO, amz, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(cfg, date)).update(stringToSign).digest("hex");
  const authorization = `${ALGO} Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { "x-amz-content-sha256": payloadHash, "x-amz-date": amz, authorization };
}

/** Variante `.eu.` d'un hôte R2 standard (juridiction Union Européenne), ou null si non applicable
 *  (déjà `.eu.`, ou hôte non-R2 : Supabase, MinIO, domaine custom). Diagnostic SPÉCIFIQUE R2 —
 *  chez les autres fournisseurs, il rend simplement `null` et la sonde ne propose rien. */
export function euJurisdictionHost(host: string): string | null {
  if (host.includes(".eu.")) return null;
  const eu = host.replace(/\.r2\.cloudflarestorage\.com$/, ".eu.r2.cloudflarestorage.com");
  return eu === host ? null : eu;
}

/** Résultat de la sonde de juridiction : où le bucket cible existe-t-il ? */
export interface JurisdictionProbe {
  bucket: string;
  configuredHost: string;
  configuredStatus: number | null; // code HTTP à l'endpoint configuré (200/403 = présent, 404 = absent)
  euHost: string | null;           // variante `.eu.` testée (null si non applicable)
  euStatus: number | null;         // code HTTP à l'endpoint `.eu.`
}

// Sonde l'EXISTENCE du bucket à un hôte donné via ListObjectsV2 (max-keys=0) — l'opération
// la moins gourmande qu'un token « Object Read & Write » peut faire. 200/403 = présent (auth
// atteint le bucket) ; 404 NoSuchBucket = absent à cette juridiction/endpoint.
async function probeBucketExists(cfg: S3Config, host: string): Promise<number> {
  const resourcePath = `/${cfg.bucket}`;
  const canonicalQuery = "list-type=2&max-keys=0"; // déjà trié (l<m) et sans caractère à encoder
  const headers = signAuthHeaders(cfg, "GET", host, resourcePath, canonicalQuery, EMPTY_SHA256);
  const res = await fetch(`https://${host}${resourcePath}?${canonicalQuery}`, { method: "GET", headers });
  return res.status;
}

/**
 * Détecte OÙ vit réellement le bucket cible : sonde l'endpoint configuré ET sa variante `.eu.`.
 * Diagnostic décisif d'un « 404 NoSuchBucket » quand le nom est avéré correct :
 *  - présent à l'endpoint configuré (200/403) → ce n'est PAS la juridiction ;
 *  - absent (404) au configuré mais présent (200/403) en `.eu.` → bucket en juridiction UE :
 *    corriger REG_S3_ENDPOINT en l'hôte `.eu.` ;
 *  - absent aux deux → nom/compte réellement faux.
 */
export async function probeJurisdiction(): Promise<JurisdictionProbe | null> {
  const cfg = config();
  if (!cfg) return null;
  const configuredHost = new URL(cfg.endpoint).host;
  const euHost = euJurisdictionHost(configuredHost);
  const [configuredStatus, euStatus] = await Promise.all([
    probeBucketExists(cfg, configuredHost).catch(sansBloquer("object-storage.probeJurisdiction.probeBucketExists", null)),
    euHost ? probeBucketExists(cfg, euHost).catch(sansBloquer("object-storage.probeJurisdiction.probeBucketExists", null)) : Promise.resolve(null),
  ]);
  return { bucket: cfg.bucket, configuredHost, configuredStatus, euHost, euStatus };
}

// ─────────────────────── REPRISE, VÉRIFICATION ET LECTURE EN FLUX ───────────────────────

/** Une partie déjà reçue par le bucket. */
export interface PartieRecue { numero: number; etag: string; taille: number }

/** Lit la réponse XML d'un `ListParts` S3. Fonction PURE — testée. */
export function parseListParts(xml: string): { parties: PartieRecue[]; suite: string | null } {
  const parties: PartieRecue[] = [];
  const re = /<Part>([\s\S]*?)<\/Part>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const bloc = m[1];
    const numero = Number(tagOf(bloc, "PartNumber"));
    const etag = tagOf(bloc, "ETag").replace(/&quot;/g, '"');
    const taille = Number(tagOf(bloc, "Size"));
    if (Number.isInteger(numero) && numero > 0 && etag) parties.push({ numero, etag, taille: Number.isFinite(taille) ? taille : 0 });
  }
  const tronque = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  const suite = tronque ? tagOf(xml, "NextPartNumberMarker") || null : null;
  return { parties, suite };
}

/**
 * LES PARTIES QUE LE BUCKET A DÉJÀ — c'est ce qui rend un envoi REPRENABLE.
 *
 * Le navigateur peut perdre ses empreintes (onglet fermé, coupure), le bucket non : on lui
 * demande ce qu'il a reçu, et seules les parties manquantes repartent. C'est aussi la source des
 * ETags de la finalisation — le serveur ne dépend plus de ce que le navigateur a gardé.
 */
export async function listParts(key: string, uploadId: string): Promise<PartieRecue[]> {
  const toutes: PartieRecue[] = [];
  let marqueur: string | null = null;
  for (let tour = 0; tour < 20; tour++) {
    const query: Record<string, string> = { uploadId, "max-parts": "1000" };
    if (marqueur) query["part-number-marker"] = marqueur;
    const res = await signedRequestQ("GET", key, query);
    const xml = await res.text();
    if (!res.ok) throw new Error(`Lecture des parties reçues échouée (${res.status}${s3ErrorCode(xml) ? ` ${s3ErrorCode(xml)}` : ""}).`);
    const { parties, suite } = parseListParts(xml);
    toutes.push(...parties);
    if (!suite) break;
    marqueur = suite;
  }
  return toutes.sort((a, b) => a.numero - b.numero);
}

/** Taille d'un objet (HEAD), ou `null` s'il n'existe pas. Lève sur toute autre erreur. */
export async function headObjectSize(key: string): Promise<number | null> {
  const res = await signedRequestQ("HEAD", key, {});
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Vérification de l'objet échouée (${res.status}).`);
  const n = Number(res.headers.get("content-length"));
  return Number.isFinite(n) ? n : null;
}

/**
 * Lit un objet EN FLUX — jamais entier en mémoire. C'est ce qui permet de traiter une archive de
 * plusieurs gigaoctets sur une instance à 512 Mo (audit du 04/10, constat 6).
 */
export async function getObjectStream(key: string): Promise<ReadableStream<Uint8Array>> {
  const res = await signedRequestQ("GET", key, {});
  if (!res.ok || !res.body) throw s3Failure("Lecture de l'objet", res, key, await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", "")));
  return res.body;
}
