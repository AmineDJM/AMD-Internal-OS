import type { CodeErreur, ErreurConnecteur, Resultat } from "./ports";

/**
 * LE CLIENT HTTP DES CONNECTEURS (lot C2) — `fetch` nu, pas de SDK.
 *
 * Ce qu'il garantit aux trois adaptateurs :
 *   • une erreur du fournisseur devient une `ErreurConnecteur` (jamais une exception) ;
 *   • 429 et les quotas GitHub (403 primaire `x-ratelimit-remaining: 0`, 403/429 secondaire) deviennent `QUOTA` avec
 *     le délai à attendre (`Retry-After`, sinon `x-ratelimit-reset` / `RateLimit-Reset`) ;
 *   • une requête qui n'est PAS partie (DNS, connexion refusée) est `RESEAU` ; une requête qui a PU partir (délai
 *     dépassé, connexion coupée) est `INCERTAIN` pour une écriture — l'appelant ne la rejoue jamais à l'aveugle ;
 *   • aucun secret ne sort : le jeton n'apparaît dans aucun message, et `masquer` efface les formes connues de jetons.
 */

export interface ConfigHttp {
  fournisseur: string;
  base: string;
  /** L'en-tête d'authentification complet (`Bearer …`) — jamais journalisé. */
  autorisation: string | null;
  entetes?: Record<string, string>;
  fetch?: typeof fetch;
  delaiMs?: number;
}

export interface ReponseHttp<T> {
  statut: number;
  corps: T | null;
  texte: string;
  entetes: Headers;
}

export type ValeurRequete = string | number | boolean | null | undefined | readonly (string | number)[];

export interface OptionsAppel {
  corps?: unknown;
  requete?: Record<string, ValeurRequete>;
  entetes?: Record<string, string>;
  /** Statuts qui ne sont PAS des erreurs pour cet appel (ex. 404 → « branche absente », 304 → cache). */
  accepter?: readonly number[];
  /** Ne lire que les `maxOctets` derniers octets du corps (journaux). */
  maxOctets?: number;
}

const FORMES_DE_JETON = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  /rnd_[A-Za-z0-9]{10,}/g,
  /whsec_[A-Za-z0-9+/=]{8,}/g,
  /(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Efface d'un texte les secrets connus ET les formes de jetons — à appeler avant TOUT message ou journal. */
export function masquer(texte: string, secrets: readonly (string | null | undefined)[] = []): string {
  let t = texte;
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join("•••");
  for (const re of FORMES_DE_JETON) t = t.replace(re, (m) => (/^(Bearer|token)\s/i.test(m) ? `${m.split(/\s+/)[0]} •••` : "•••"));
  return t;
}

/** `Retry-After` en secondes ou en date HTTP → millisecondes ; `null` si absent ou illisible. */
export function lireRetryAfter(valeur: string | null, maintenant = Date.now()): number | null {
  if (!valeur) return null;
  const v = valeur.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.max(0, ms - maintenant) : null;
}

/** Le délai avant de réessayer d'après les en-têtes connus des trois fournisseurs. */
export function delaiDeQuota(entetes: Headers, maintenant = Date.now()): number | null {
  const ra = lireRetryAfter(entetes.get("retry-after"), maintenant);
  if (ra !== null) return ra;
  const resetGithub = entetes.get("x-ratelimit-reset");
  if (resetGithub && /^\d+$/.test(resetGithub)) return Math.max(0, Number(resetGithub) * 1000 - maintenant);
  const resetRender = entetes.get("ratelimit-reset");
  if (resetRender && /^\d+$/.test(resetRender)) {
    const n = Number(resetRender);
    // Render : secondes avant la réinitialisation (petit nombre) ; une date epoch est > 1e9.
    return n > 1e9 ? Math.max(0, n * 1000 - maintenant) : n * 1000;
  }
  return null;
}

const CODES_AVANT_ENVOI = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_INVALID_URL", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]);

/** La requête est-elle certainement restée chez nous ? (sinon : elle a pu être reçue). */
export function partieAvantEnvoi(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return false;
  const code = e?.cause?.code ?? e?.code;
  return Boolean(code && CODES_AVANT_ENVOI.has(code));
}

function codePourStatut(statut: number, entetes: Headers, texte: string): CodeErreur {
  if (statut === 429) return "QUOTA";
  if (statut === 403 && (entetes.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(texte))) return "QUOTA";
  if (statut === 401) return "AUTH";
  if (statut === 403) return "INTERDIT";
  if (statut === 404 || statut === 410) return "INTROUVABLE";
  if (statut === 409) return "CONFLIT";
  if (statut === 400 || statut === 406 || statut === 422) return "INVALIDE";
  if (statut >= 500) return "INDISPONIBLE";
  return "INCONNU";
}

/** Le message utile d'un corps d'erreur (Anthropic `{error:{message}}`, GitHub et Render `{message}`). */
function messageDuCorps(texte: string): string | null {
  try {
    const j = JSON.parse(texte) as { message?: unknown; error?: { message?: unknown; type?: unknown } };
    const m = typeof j?.error?.message === "string" ? j.error.message : typeof j?.message === "string" ? j.message : null;
    const type = typeof j?.error?.type === "string" ? ` (${j.error.type})` : "";
    return m ? `${m}${type}` : null;
  } catch {
    return texte.trim() ? texte.trim().slice(0, 200) : null;
  }
}

export function erreurDeReponse(cfg: ConfigHttp, statut: number, entetes: Headers, texte: string, maintenant = Date.now()): ErreurConnecteur {
  const code = codePourStatut(statut, entetes, texte);
  const delai = code === "QUOTA" ? delaiDeQuota(entetes, maintenant) ?? 60_000 : statut === 503 ? delaiDeQuota(entetes, maintenant) ?? undefined : undefined;
  const detail = messageDuCorps(texte);
  const requeteId = entetes.get("request-id") ?? entetes.get("x-github-request-id") ?? entetes.get("x-request-id") ?? undefined;
  return {
    code,
    statut,
    message: masquer(`${cfg.fournisseur} : HTTP ${statut}${detail ? ` — ${detail.slice(0, 300)}` : ""}`, [cfg.autorisation]),
    reessayable: code === "QUOTA" || code === "INDISPONIBLE",
    ...(delai !== undefined ? { reessayerApresMs: delai } : {}),
    ...(requeteId ? { requeteId } : {}),
  };
}

export function erreurReseau(cfg: ConfigHttp, methode: string, err: unknown): ErreurConnecteur {
  const avant = partieAvantEnvoi(err);
  const lecture = methode === "GET" || methode === "HEAD";
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const quoi = e?.name === "TimeoutError" || e?.name === "AbortError" ? "délai dépassé" : e?.cause?.code ?? e?.message ?? "erreur réseau";
  if (avant || lecture) {
    return { code: "RESEAU", message: masquer(`${cfg.fournisseur} : injoignable (${quoi})`, [cfg.autorisation]), reessayable: true };
  }
  return {
    code: "INCERTAIN",
    message: masquer(`${cfg.fournisseur} : ${quoi} — la demande a pu être reçue ; ne pas la rejouer sans vérifier`, [cfg.autorisation]),
    reessayable: false,
  };
}

export function construireUrl(base: string, chemin: string, requete?: Record<string, ValeurRequete>): string {
  const url = /^https?:\/\//.test(chemin) ? new URL(chemin) : new URL(`${base.replace(/\/+$/, "")}/${chemin.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(requete ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** UN appel. Rend la réponse (statut accepté) ou l'erreur normalisée. */
export async function appeler<T>(cfg: ConfigHttp, methode: string, chemin: string, opts: OptionsAppel = {}): Promise<Resultat<ReponseHttp<T>>> {
  if (!cfg.autorisation) {
    return { ok: false, erreur: { code: "NON_CONFIGURE", message: `${cfg.fournisseur} : jeton non configuré`, reessayable: false } };
  }
  const f = cfg.fetch ?? globalThis.fetch;
  const entetes: Record<string, string> = { accept: "application/json", ...cfg.entetes, ...opts.entetes, authorization: cfg.autorisation };
  if (opts.corps !== undefined) entetes["content-type"] = "application/json";
  let reponse: Response;
  try {
    reponse = await f(construireUrl(cfg.base, chemin, opts.requete), {
      method: methode,
      headers: entetes,
      body: opts.corps !== undefined ? JSON.stringify(opts.corps) : undefined,
      signal: AbortSignal.timeout(cfg.delaiMs ?? 20_000),
      redirect: "follow",
    });
  } catch (err) {
    return { ok: false, erreur: erreurReseau(cfg, methode, err) };
  }
  let texte = "";
  try {
    texte = await reponse.text();
  } catch (err) {
    return { ok: false, erreur: erreurReseau(cfg, "GET", err) };
  }
  if (opts.maxOctets && texte.length > opts.maxOctets) texte = texte.slice(-opts.maxOctets);
  const accepte = reponse.ok || (opts.accepter ?? []).includes(reponse.status);
  if (!accepte) return { ok: false, erreur: erreurDeReponse(cfg, reponse.status, reponse.headers, texte) };
  let corps: T | null = null;
  if (texte && (reponse.headers.get("content-type") ?? "").includes("json")) {
    try { corps = JSON.parse(texte) as T; } catch { corps = null; }
  }
  return { ok: true, valeur: { statut: reponse.status, corps, texte, entetes: reponse.headers } };
}

/** L'URL `rel="next"` d'un en-tête `Link` (pagination GitHub). */
export function pageSuivante(link: string | null): string | null {
  if (!link) return null;
  for (const partie of link.split(",")) {
    const m = partie.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1]!;
  }
  return null;
}

export const echec = <T>(code: CodeErreur, message: string, reessayable = false): Resultat<T> => ({ ok: false, erreur: { code, message, reessayable } });
