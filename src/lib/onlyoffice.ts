import crypto from "crypto";

/**
 * Intégration de l'éditeur Office auto-hébergé (OnlyOffice Document Server).
 *
 * **Serveur uniquement** : le secret JWT n'est jamais exposé au navigateur. L'éditeur
 * n'est ACTIF que si `ONLYOFFICE_URL` (URL **publique** du Document Server, joignable
 * par le navigateur ET par notre serveur) et `ONLYOFFICE_JWT_SECRET` sont définis.
 * Tant qu'ils ne le sont pas, tout reste inerte (aucun bouton « Modifier », aucune route active).
 */

const secret = () => process.env.ONLYOFFICE_JWT_SECRET || "";
const server = () => (process.env.ONLYOFFICE_URL || "").replace(/\/+$/, "");

export function onlyofficeConfigured(): boolean {
  return Boolean(server() && secret());
}
export function onlyofficeServerUrl(): string {
  return server();
}

/** Le script d'intégration de l'éditeur (null : éditeur non configuré) — chargé à l'ouverture, préchargé au survol. */
export function onlyofficeApiJs(): string | null {
  return onlyofficeConfigured() ? `${server()}/web-apps/apps/api/documents/api.js` : null;
}

/** URL publique de l'application, joignable par le Document Server (serveur-à-serveur). */
export function appBaseUrl(): string {
  return (process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.AUTH_URL || "").replace(/\/+$/, "");
}

// ───────────────────────── JWT HS256 (sans dépendance externe) ─────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

/** Signe un payload en JWT HS256 avec le secret OnlyOffice (iat/exp ajoutés). */
export function signJwt(payload: Record<string, unknown>, expiresInSec = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson({ ...payload, iat: now, exp: now + expiresInSec });
  const data = `${head}.${body}`;
  const sig = b64url(crypto.createHmac("sha256", secret()).update(data).digest());
  return `${data}.${sig}`;
}

/** Vérifie la signature + l'expiration d'un JWT HS256. Renvoie le payload ou null. */
export function verifyJwt<T = Record<string, unknown>>(token: string | null | undefined): T | null {
  const key = secret();
  if (!key || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64url(crypto.createHmac("sha256", secret()).update(`${h}.${p}`).digest());
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64").toString("utf8")) as { exp?: number };
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as T;
  } catch {
    return null;
  }
}

// ───────────────────────── Types de documents éditables ─────────────────────────

const EXT_TYPE: Record<string, "word" | "cell" | "slide"> = {
  doc: "word", docx: "word", odt: "word", rtf: "word", txt: "word", dotx: "word", docm: "word", ott: "word",
  xls: "cell", xlsx: "cell", ods: "cell", csv: "cell", xlsm: "cell", xltx: "cell", ots: "cell",
  ppt: "slide", pptx: "slide", odp: "slide", pptm: "slide", potx: "slide", ppsx: "slide", otp: "slide",
};

/**
 * LES FORMATS QUE L'ÉDITEUR SAIT OUVRIR EN LECTURE seulement (anciens ou exotiques) : on les AFFICHE tels quels dans
 * l'éditeur, sans les convertir en autre chose, mais on ne les réenregistre pas (le format d'origine ne se réécrit pas
 * fidèlement). Pour les modifier, on les télécharge ou on les enregistre sous un format éditable depuis l'éditeur.
 */
const LECTURE_SEULE: Record<string, "word" | "cell" | "slide"> = {
  dot: "word", dotm: "word", fodt: "word", wps: "word", wpt: "word", pages: "word", sxw: "word", stw: "word", hwp: "word", hwpx: "word",
  epub: "word", fb2: "word", djvu: "word", xps: "word", oxps: "word", mht: "word", mhtml: "word", wri: "word", html: "word", htm: "word",
  xlsb: "cell", xlt: "cell", xltm: "cell", fods: "cell", numbers: "cell", et: "cell", sxc: "cell", stc: "cell",
  pps: "slide", ppsm: "slide", pot: "slide", potm: "slide", fodp: "slide", key: "slide", dps: "slide", sxi: "slide", sti: "slide",
};

export function fileExt(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/** Catégorie d'éditeur OnlyOffice pour un fichier, ou null s'il n'est pas éditable. */
export function onlyofficeDocType(name: string): "word" | "cell" | "slide" | null {
  return EXT_TYPE[fileExt(name)] ?? null;
}

/** Catégorie d'éditeur pour OUVRIR un fichier (édition OU lecture seule), ou null si l'éditeur ne sait pas l'ouvrir. */
export function onlyofficeTypeOuvrable(name: string): "word" | "cell" | "slide" | null {
  const e = fileExt(name);
  return EXT_TYPE[e] ?? LECTURE_SEULE[e] ?? null;
}

/** Un document Office est-il éditable par OnlyOffice ? */
export function onlyofficeEditable(name: string): boolean {
  return onlyofficeDocType(name) !== null;
}

/**
 * LES EXTENSIONS QUE L'ÉDITEUR OUVRE, dérivées de la table — jamais réécrites à la main.
 *
 * Un refus doit nommer ce qui EST admis, sinon la personne devine (§118.30). Et la liste vient
 * de `EXT_TYPE` : écrite à la main, elle serait fausse au premier format ajouté, en silence
 * (§118.73).
 */
export function extensionsEditables(): string[] {
  return Object.keys(EXT_TYPE).sort();
}

// ───────────────────────── Jeton de session d'édition ─────────────────────────

export interface EditToken {
  nodeId: string;
  userId: string;
  kind: "edit";
}

/** Jeton (signé) autorisant le Document Server à lire le fichier et à rappeler la sauvegarde. */
export function makeEditToken(nodeId: string, userId: string, expiresInSec = 24 * 3600): string {
  return signJwt({ nodeId, userId, kind: "edit" }, expiresInSec);
}
export function readEditToken(token: string | null | undefined): EditToken | null {
  const p = verifyJwt<EditToken>(token);
  return p && p.kind === "edit" ? p : null;
}

/** Variante pour les **documents** (modèle Document, hors Drive) : pièces des dossiers,
 *  Regulatory, etc. Même mécanisme de jeton signé, discriminé par `kind`. */
export interface DocEditToken {
  docId: string;
  userId: string;
  kind: "docedit";
}
export function makeDocEditToken(docId: string, userId: string, expiresInSec = 24 * 3600): string {
  return signJwt({ docId, userId, kind: "docedit" }, expiresInSec);
}
export function readDocEditToken(token: string | null | undefined): DocEditToken | null {
  const p = verifyJwt<DocEditToken>(token);
  return p && p.kind === "docedit" ? p : null;
}
