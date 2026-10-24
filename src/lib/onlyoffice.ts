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

// ───────────────────────── Jetons : LIRE n'est pas ENREGISTRER ─────────────────────────
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// UN JETON QUI PERMET DE LIRE NE PERMET PLUS D'ENREGISTRER (audit 2026-10-24).
//
// ── LE DÉFAUT ────────────────────────────────────────────────────────────────────────────
//
// Un seul jeton par ouverture servait aux deux routes : il était posé dans `document.url`
// (qui part au NAVIGATEUR dans la configuration de l'éditeur) ET dans `callbackUrl`, que l'on
// soit en lecture ou en édition. Le rappel, lui, acceptait un corps NON signé dès lors que le
// jeton était bon, téléchargeait `body.url` quelle qu'en soit l'adresse, et écrivait une
// nouvelle version sans relire le droit. Une personne qui ne pouvait que LIRE un fichier
// pouvait donc le remplacer par le contenu de n'importe quelle adresse — et faire appeler au
// serveur l'adresse de son choix.
//
// ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
//
//   · le jeton de LECTURE (`document.url`, conversions PDF) ne vaut que pour /api/onlyoffice/file ;
//   · le jeton d'ENREGISTREMENT n'est émis qu'en mode édition, dans `callbackUrl` seulement ;
//   · le rappel n'est cru que SIGNÉ par le Document Server (le secret JWT est obligatoire pour
//     que l'éditeur soit actif : un corps non signé ne vient pas de lui), ses valeurs se lisent
//     dans la partie SIGNÉE, et l'adresse à télécharger doit être celle du Document Server ;
//   · le droit d'enregistrer est RELU au moment du rappel (`peutEnregistrerOnlyoffice`) : un
//     droit retiré après l'ouverture ne s'exerce plus.
//
// Transition : les jetons émis avant ce changement (`kind: "edit" | "docedit"`) restent lus par
// les deux routes. Plus aucun n'est émis ; ils expirent d'eux-mêmes (24 h au plus), et un éditeur
// ouvert pendant le déploiement peut encore enregistrer — sous les mêmes contrôles.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Jeton de LECTURE d'un fichier du Drive : le Document Server le télécharge, rien de plus. */
export interface FileReadToken {
  nodeId: string;
  userId: string;
  kind: "lecture";
}

export function makeFileReadToken(nodeId: string, userId: string, expiresInSec = 24 * 3600): string {
  return signJwt({ nodeId, userId, kind: "lecture" }, expiresInSec);
}
export function readFileReadToken(token: string | null | undefined): FileReadToken | null {
  const p = verifyJwt<{ nodeId?: string; userId?: string; kind?: string }>(token);
  // `edit` : jeton émis avant la séparation lecture / enregistrement (transition, 24 h au plus).
  if (!p || (p.kind !== "lecture" && p.kind !== "edit") || !p.nodeId || !p.userId) return null;
  return { nodeId: p.nodeId, userId: p.userId, kind: "lecture" };
}

/** Variante pour les **documents** (modèle Document, hors Drive) : pièces des dossiers, Regulatory, etc. */
export interface DocReadToken {
  docId: string;
  userId: string;
  kind: "doclecture";
}
export function makeDocReadToken(docId: string, userId: string, expiresInSec = 24 * 3600): string {
  return signJwt({ docId, userId, kind: "doclecture" }, expiresInSec);
}
export function readDocReadToken(token: string | null | undefined): DocReadToken | null {
  const p = verifyJwt<{ docId?: string; userId?: string; kind?: string }>(token);
  if (!p || (p.kind !== "doclecture" && p.kind !== "docedit") || !p.docId || !p.userId) return null;
  return { docId: p.docId, userId: p.userId, kind: "doclecture" };
}

export type CibleEnregistrement = "drive" | "document";

/** Jeton d'ENREGISTREMENT : émis en mode édition seulement, posé dans `callbackUrl` et nulle part ailleurs. */
export interface SaveToken {
  cible: CibleEnregistrement;
  id: string;
  userId: string;
  kind: "enregistrement";
}
export function makeSaveToken(cible: CibleEnregistrement, id: string, userId: string, expiresInSec = 24 * 3600): string {
  return signJwt({ cible, id, userId, kind: "enregistrement" }, expiresInSec);
}
export function readSaveToken(token: string | null | undefined): SaveToken | null {
  const p = verifyJwt<{ cible?: string; id?: string; nodeId?: string; docId?: string; userId?: string; kind?: string }>(token);
  if (!p || !p.userId) return null;
  if (p.kind === "enregistrement" && (p.cible === "drive" || p.cible === "document") && p.id) {
    return { cible: p.cible, id: p.id, userId: p.userId, kind: "enregistrement" };
  }
  // Transition : jetons uniques d'avant la séparation (voir l'en-tête de section).
  if (p.kind === "edit" && p.nodeId) return { cible: "drive", id: p.nodeId, userId: p.userId, kind: "enregistrement" };
  if (p.kind === "docedit" && p.docId) return { cible: "document", id: p.docId, userId: p.userId, kind: "enregistrement" };
  return null;
}

// ───────────────────────── Le rappel d'enregistrement ─────────────────────────

export type RappelOnlyoffice =
  | { action: "ignorer" }
  | { action: "enregistrer"; jeton: SaveToken; url: string }
  | { action: "refuser"; raison: string };

/**
 * Lit un rappel du Document Server SANS rien écrire ni télécharger : la décision est pure, la route
 * applique (relecture du droit en base, puis écriture). Statuts 2 (document prêt) et 6 (enregistrement
 * forcé) seulement — tout autre statut est acquitté sans effet.
 */
export function lireRappelOnlyoffice(e: {
  jeton: string | null;
  id: string | null;
  docId: string | null;
  corps: unknown;
  autorisation: string | null;
}): RappelOnlyoffice {
  const jeton = readSaveToken(e.jeton);
  if (!jeton) return { action: "refuser", raison: "jeton d'enregistrement absent, expiré ou invalide" };
  const idDeLAdresse = jeton.cible === "drive" ? e.id : e.docId;
  if (!idDeLAdresse || idDeLAdresse !== jeton.id) return { action: "refuser", raison: "le jeton ne désigne pas ce fichier" };

  const corps = e.corps && typeof e.corps === "object" ? (e.corps as Record<string, unknown>) : null;
  if (!corps) return { action: "refuser", raison: "corps illisible" };
  const signe = (typeof corps.token === "string" && corps.token)
    || (e.autorisation ?? "").replace(/^Bearer\s+/i, "");
  if (!signe) {
    return { action: "refuser", raison: "corps non signé — activez JWT_ENABLED sur le Document Server, avec le même secret que ONLYOFFICE_JWT_SECRET" };
  }
  const verifie = verifyJwt<{ payload?: Record<string, unknown> } & Record<string, unknown>>(signe);
  if (!verifie) return { action: "refuser", raison: "signature du Document Server invalide ou expirée" };
  // En en-tête, le Document Server enveloppe le corps dans `payload` ; dans le corps, il le signe tel quel.
  const charge = (verifie.payload && typeof verifie.payload === "object" ? verifie.payload : verifie) as Record<string, unknown>;

  const status = charge.status;
  if (status !== 2 && status !== 6) return { action: "ignorer" };
  if (typeof charge.url !== "string") return { action: "refuser", raison: "adresse du document absente" };

  // Le fichier se télécharge chez le Document Server, nulle part ailleurs. On compare l'HÔTE seul : un
  // mandataire TLS devant le Document Server peut lui faire écrire `http://` pour son adresse publique.
  let hote: string;
  let hoteAttendu: string;
  try {
    const u = new URL(charge.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { action: "refuser", raison: "adresse du document non HTTP" };
    hote = u.hostname.toLowerCase();
    hoteAttendu = new URL(server()).hostname.toLowerCase();
  } catch {
    return { action: "refuser", raison: "adresse du document illisible" };
  }
  if (hote !== hoteAttendu) return { action: "refuser", raison: `adresse hors du Document Server (${hote})` };

  return { action: "enregistrer", jeton, url: charge.url };
}
