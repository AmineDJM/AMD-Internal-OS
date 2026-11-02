import { createHash } from "node:crypto";
import { ECRAN_LIAISON } from "./ecran";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONFIGURATION DE LA LIAISON AU SITE ADVENTUM (§118.158, §118.159) — pure : elle ne lit que
 * l'environnement qu'on lui donne et les identifiants qu'on lui passe.
 *
 * ── D'OÙ VIENT LA CLÉ ────────────────────────────────────────────────────────────────────
 *
 *   1. De l'ERP LUI-MÊME (§118.159) : un Super Admin clique « Générer », l'ERP fabrique la clé et
 *      le secret de signature, les scelle en base (`cles.ts`, `secret-box`) et les promeut dès
 *      que le site les reconnaît. C'est le chemin normal — personne n'a à fabriquer une clé ni à
 *      la recopier des deux côtés.
 *   2. De l'environnement (`ADVENTUM_API_KEY`, `ADVENTUM_WEBHOOK_SECRET`), en repli : c'était le
 *      seul chemin au §118.158, il reste valable pour qui l'a déjà posé.
 *
 * Une clé ACTIVE de l'ERP l'emporte sur l'environnement, et ce n'est pas une préférence : elle
 * n'est devenue active que parce que le SITE l'a reconnue. Le site ne porte qu'une clé ; si c'est
 * celle-là, celle de l'environnement n'est plus la sienne.
 *
 * « La clé donne le droit de publier sur le site public. Elle ne transite jamais dans une URL,
 * uniquement dans l'en-tête Authorization. Ne pas la committer dans un dépôt. » (contrat, §2)
 * Ce qui sort d'ici pour l'écran ou la base, c'est une EMPREINTE : un condensat tronqué, qui dit
 * « est-ce la même clé qu'hier ? » sans rien révéler d'elle.
 *
 * ── L'ADRESSE A UNE VALEUR PAR DÉFAUT, ET ELLE EST MESURÉE ──────────────────────────────
 *
 * Le contrat du site écrit `https://www.adventumdz.com`. Mesuré le 30/09/2026 : cette adresse
 * répond 301 vers `https://adventumdz.com`, qui sert l'API (`/api/v1/health` →
 * `adventum-content-api`). Configurée telle que le contrat la donne, CHAQUE requête aurait été une
 * redirection — que la file refuse de suivre (elle emporterait la clé) et range en blocage.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ADRESSE_PAR_DEFAUT = "https://adventumdz.com";

export type SourceCle = "ERP" | "ENVIRONNEMENT";

/** Les identifiants scellés en base par l'ERP (§118.159), une fois ouverts. */
export interface IdentifiantsStockes {
  id: string;
  cle: string;
  secret: string | null;
  empreinte: string;
}

export interface ConfigurationSite {
  /** L'adresse de l'API, normalisée : `https://adventumdz.com/api/v1`. */
  base: string;
  /** La racine publique du site, pour composer les liens (`https://adventumdz.com`). */
  racine: string;
  cle: string;
  secret: string | null;
  /**
   * Empreinte de (adresse, clé, secret de signature) — change dès que l'un des trois change. C'est
   * elle qui lève un blocage : un 401 peut venir de la clé comme de la SIGNATURE, et réparer l'une
   * ou l'autre doit suffire à relancer les envois.
   */
  empreinte: string;
  source: SourceCle;
  /** La ligne `SiteWebCle` quand la clé vient de l'ERP. */
  cleId: string | null;
}

export type LectureConfiguration =
  | { ok: true; config: ConfigurationSite }
  | { ok: false; raison: string; manquantes: string[] };

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Un hôte de la machine elle-même : une requête vers lui ne sort pas (§118.159, garde de sortie). */
export function hoteLocal(url: string): boolean {
  try {
    return HOTES_LOCAUX.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * L'ADRESSE DU SITE, normalisée. Elle accepte la racine (`https://adventumdz.com`) ou l'adresse de
 * l'API (`…/api/v1`), avec ou sans barre finale.
 *
 * Refus nommés, parce qu'une clé partirait avec chaque requête : pas de `http://` hors d'un poste
 * local (la clé circulerait en clair), pas d'identifiants dans l'adresse.
 */
export function normaliserBase(brut: string): { ok: true; base: string; racine: string } | { ok: false; raison: string } {
  const s = brut.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, raison: `ADVENTUM_BASE_URL n'est pas une adresse lisible (« ${s.slice(0, 80)} »).` };
  }
  const local = HOTES_LOCAUX.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { ok: false, raison: "ADVENTUM_BASE_URL doit être en https : la clé d'API part avec chaque requête, elle ne circule jamais en clair." };
  }
  if (u.username || u.password) {
    return { ok: false, raison: "ADVENTUM_BASE_URL ne doit pas porter d'identifiants : la clé est gérée par l'ERP." };
  }
  const chemin = u.pathname.replace(/\/+$/, "");
  const racineChemin = chemin.endsWith("/api/v1") ? chemin.slice(0, -"/api/v1".length) : chemin;
  const origine = `${u.protocol}//${u.host}`;
  return { ok: true, base: `${origine}${racineChemin}/api/v1`, racine: `${origine}${racineChemin}` };
}

/** L'adresse du site en vigueur : l'environnement s'il la fixe, sinon la valeur mesurée. */
export function adresseDuSite(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; base: string; racine: string; parDefaut: boolean }
  | { ok: false; raison: string } {
  const brut = (env.ADVENTUM_BASE_URL ?? "").trim();
  const n = normaliserBase(brut || ADRESSE_PAR_DEFAUT);
  return n.ok ? { ...n, parDefaut: !brut } : n;
}

export function empreinteDe(base: string, cle: string, secret: string | null = null): string {
  return createHash("sha256").update(`${base}\n${cle}\n${secret ?? ""}`, "utf8").digest("hex").slice(0, 16);
}

/** L'empreinte d'une CLÉ seule — un condensat, jamais un morceau de la clé (ses derniers caractères en sont une partie). */
export function empreinteCle(cle: string): string {
  return createHash("sha256").update(`cle\n${cle}`, "utf8").digest("hex").slice(0, 12);
}

export const RAISON_NON_RELIE =
  `Le site n'est pas encore relié : un Super Admin génère la clé depuis ${ECRAN_LIAISON.nom} — un bloc à coller dans Render, rien d'autre.`;

/**
 * LIT LA CONFIGURATION — l'adresse, et la clé stockée par l'ERP si elle existe, sinon celle de
 * l'environnement. Rend ce qui MANQUE plutôt qu'un simple « non ».
 */
export function lireConfiguration(env: NodeJS.ProcessEnv = process.env, stockee: IdentifiantsStockes | null = null): LectureConfiguration {
  const adresse = adresseDuSite(env);
  if (!adresse.ok) return { ok: false, raison: adresse.raison, manquantes: [] };
  if (stockee) {
    return {
      ok: true,
      config: {
        base: adresse.base, racine: adresse.racine, cle: stockee.cle, secret: stockee.secret,
        empreinte: empreinteDe(adresse.base, stockee.cle, stockee.secret), source: "ERP", cleId: stockee.id,
      },
    };
  }
  // Une clé collée depuis un terminal emporte souvent son retour à la ligne : on le retire. Une
  // espace AU MILIEU, en revanche, n'est pas une clé — c'est un collage raté, et on le dit.
  const cle = (env.ADVENTUM_API_KEY ?? "").trim();
  if (!cle) return { ok: false, raison: RAISON_NON_RELIE, manquantes: ["clé de liaison"] };
  if (/\s/.test(cle)) {
    return { ok: false, raison: "ADVENTUM_API_KEY contient une espace : la valeur collée n'est pas une clé entière.", manquantes: [] };
  }
  const secret = (env.ADVENTUM_WEBHOOK_SECRET ?? "").trim() || null;
  return {
    ok: true,
    config: {
      base: adresse.base, racine: adresse.racine, cle, secret, empreinte: empreinteDe(adresse.base, cle, secret),
      source: "ENVIRONNEMENT", cleId: null,
    },
  };
}

/**
 * CE QUE L'ÉCRAN PEUT MONTRER de la configuration — et rien de plus. Jamais la clé, jamais sa
 * fin : seulement l'empreinte, et d'où la clé vient.
 */
export interface ApercuConfiguration {
  configuree: boolean;
  raison: string | null;
  manquantes: string[];
  adresse: string | null;
  racine: string | null;
  adresseParDefaut: boolean;
  signature: boolean;
  empreinte: string | null;
  source: SourceCle | null;
}

export function apercuDe(lecture: LectureConfiguration, env: NodeJS.ProcessEnv = process.env): ApercuConfiguration {
  const adresse = adresseDuSite(env);
  const racine = adresse.ok ? adresse.racine : null;
  const parDefaut = adresse.ok ? adresse.parDefaut : false;
  if (!lecture.ok) {
    return {
      configuree: false, raison: lecture.raison, manquantes: lecture.manquantes, adresse: adresse.ok ? adresse.base : null, racine,
      adresseParDefaut: parDefaut, signature: false, empreinte: null, source: null,
    };
  }
  const c = lecture.config;
  return {
    configuree: true, raison: null, manquantes: [], adresse: c.base, racine: c.racine, adresseParDefaut: parDefaut,
    signature: c.secret !== null, empreinte: c.empreinte, source: c.source,
  };
}

/** L'adresse publique complète d'un contenu, à partir de l'URL relative que le site a rendue. */
export function urlPublique(relative: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!relative) return null;
  if (/^https?:\/\//i.test(relative)) return relative;
  const a = adresseDuSite(env);
  if (!a.ok) return null;
  return `${a.racine}${relative.startsWith("/") ? "" : "/"}${relative}`;
}
