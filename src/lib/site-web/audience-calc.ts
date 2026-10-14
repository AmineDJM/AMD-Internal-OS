/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AUDIENCE DU SITE PUBLIC — la part PURE (Direction, 07/10) : aucun import, aucune lecture.
 *
 * Ce que le navigateur d'un visiteur envoie est lu ici (`validerEvenement`), son agent utilisateur
 * réduit à trois mots (`analyserAgent`), sa provenance nommée (`sourceDepuis`) ; et l'écran y
 * prend ses calculs (périodes, variations, taux, durées). Les requêtes vivent dans `audience.ts`,
 * la collecte dans `audience-collecte.ts`.
 *
 * Rien de ce qui sort d'ici n'identifie une personne : ni adresse IP, ni agent utilisateur brut,
 * ni chaîne de requête (une adresse de page peut porter un e-mail en paramètre — elle est coupée
 * au `?`), ni chemin du référent (seul son hôte est gardé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPES_EVENEMENT = ["PAGEVIEW", "CLICK", "LEAVE"] as const;
export type TypeEvenement = (typeof TYPES_EVENEMENT)[number];

/** Un lot ne dépasse pas 50 événements ; un corps, 64 Ko. */
export const LOT_MAX = 50;
export const CORPS_MAX = 64 * 1024;
/** Une durée au-delà de 30 minutes sur une page est un onglet oublié, pas une lecture. */
export const DUREE_MAX_MS = 30 * 60_000;
/** Les événements de plus de 13 mois sont purgés. */
export const RETENTION_MOIS = 13;

/** Les clics reconnus d'eux-mêmes par le script, et leur nom à l'écran. */
export const LIBELLES_CLIC: Record<string, string> = {
  postuler: "Postuler",
  telephone: "Téléphone",
  email: "E-mail",
  whatsapp: "WhatsApp",
  externe: "Liens externes",
  telechargement: "Téléchargements",
  cta: "Appels à l'action",
};

/** Longueur maximale d'un nom de clic — `postuler-<poste>-envoyer` doit tenir entier. */
export const LABEL_MAX = 80;

export function libelleClic(label: string | null): string {
  if (!label) return "Autre";
  if (LIBELLES_CLIC[label]) return LIBELLES_CLIC[label];
  // L'entonnoir par offre que le site marque : `postuler-<poste>` puis `postuler-<poste>-envoyer`.
  const envoi = /^postuler-(.+)-envoyer$/.exec(label);
  if (envoi) return `Candidature envoyée — ${envoi[1]}`;
  const offre = /^postuler-(.+)$/.exec(label);
  if (offre) return `Postuler — ${offre[1]}`;
  return label;
}

// ───────────────────────────── L'agent utilisateur ─────────────────────────────

const ROBOT =
  /bot\b|bot\/|crawl|spider|slurp|bingpreview|mediapartners|facebookexternalhit|embedly|quora link|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|python-|curl\/|wget|httpclient|okhttp|java\/|go-http|axios|node-fetch|phantomjs|selenium|puppeteer|playwright|scrapy|preview/i;

export interface AgentAnalyse {
  robot: boolean;
  device: "Mobile" | "Tablette" | "Ordinateur";
  browser: string;
  os: string;
}

/** Trois mots tirés de l'agent utilisateur — qui, lui, n'est jamais gardé. Vide = robot. */
export function analyserAgent(ua: string | null | undefined): AgentAnalyse {
  const s = (ua ?? "").slice(0, 512);
  const robot = s.trim().length === 0 || ROBOT.test(s);
  const tablette = /iPad|Tablet|PlayBook|Silk|Kindle/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s));
  const mobile = !tablette && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini|IEMobile/i.test(s);
  const device = tablette ? "Tablette" : mobile ? "Mobile" : "Ordinateur";

  const browser =
    /Edg(e|A|iOS)?\//.test(s) ? "Edge"
      : /OPR\/|Opera/.test(s) ? "Opera"
        : /SamsungBrowser/.test(s) ? "Samsung Internet"
          : /YaBrowser/.test(s) ? "Yandex"
            : /Firefox\/|FxiOS/.test(s) ? "Firefox"
              : /Chrome\/|CriOS|Chromium/.test(s) ? "Chrome"
                : /Safari\//.test(s) && /Version\//.test(s) ? "Safari"
                  : "Autre";

  const os =
    /Windows/.test(s) ? "Windows"
      : /Android/.test(s) ? "Android"
        : /iPhone|iPad|iPod/.test(s) ? "iOS"
          : /CrOS/.test(s) ? "ChromeOS"
            : /Mac OS X|Macintosh/.test(s) ? "macOS"
              : /Linux/.test(s) ? "Linux"
                : "Autre";

  return { robot, device, browser, os };
}

// ───────────────────────────── La provenance ─────────────────────────────

/** L'hôte d'un référent, en minuscules, sans « www. » — ni chemin, ni paramètres. */
export function hoteDuReferent(referent: string | null | undefined): string | null {
  const s = (referent ?? "").trim();
  if (!s) return null;
  let hote = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      hote = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  hote = hote.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]{1,100}$/.test(hote) || (!hote.includes(".") && hote !== "localhost")) return null;
  return hote;
}

const SOURCES_PAR_MOT: [RegExp, string][] = [
  [/e-?mail|newsletter|courriel|^mail$|mailchimp|brevo|sendinblue/i, "E-mail"],
  [/google|gclid/i, "Google"],
  [/bing/i, "Bing"],
  [/linkedin|lnkd/i, "LinkedIn"],
  [/facebook|^fb$|meta/i, "Facebook"],
  [/instagram|^ig$/i, "Instagram"],
  [/twitter|^x$|^t\.co$/i, "X (Twitter)"],
  [/whatsapp|^wa$/i, "WhatsApp"],
  [/emploitic/i, "Emploitic"],
];

const SOURCES_PAR_HOTE: [RegExp, string][] = [
  [/^(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|webmail\..+|mail\..+)$/, "E-mail"],
  [/(^|\.)google\.[a-z.]+$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "LinkedIn"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, "X (Twitter)"],
  [/(^|\.)(whatsapp\.com|whatsapp\.net|wa\.me)$/, "WhatsApp"],
  [/(^|\.)emploitic\.com$/, "Emploitic"],
];

/**
 * LA SOURCE D'UNE VISITE — `utm_source` s'il est donné (normalisé : « linkedin » → « LinkedIn »),
 * sinon déduite de l'hôte du référent ; « Direct » sans référent ou depuis le site lui-même.
 */
export function sourceDepuis(p: { utmSource?: string | null; referrerHost?: string | null; hotesDuSite?: string[] }): string {
  const utm = (p.utmSource ?? "").trim().slice(0, 60);
  if (utm) {
    for (const [re, nom] of SOURCES_PAR_MOT) if (re.test(utm)) return nom;
    return utm.charAt(0).toUpperCase() + utm.slice(1);
  }
  const hote = p.referrerHost ?? null;
  if (!hote) return "Direct";
  if ((p.hotesDuSite ?? []).some((h) => h === hote)) return "Direct";
  for (const [re, nom] of SOURCES_PAR_HOTE) if (re.test(hote)) return nom;
  return "Autre";
}

// ───────────────────────────── Ce que le navigateur envoie ─────────────────────────────

export interface EvenementValide {
  type: TypeEvenement;
  path: string;
  title: string | null;
  referrer: string | null;
  utmSource: string | null;
  medium: string | null;
  campaign: string | null;
  session: string | null;
  label: string | null;
  target: string | null;
  durationMs: number | null;
}

// eslint-disable-next-line no-control-regex -- c'est précisément eux qu'on retire
const CONTROLE = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const UN_CONTROLE = /[\u0000-\u001f\u007f]/;

function texte(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROLE, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** Un chemin RELATIF du site : commence par « / » (jamais « // »), coupé au `?` et au `#`. */
export function normaliserChemin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let p = v.trim().split(/[?#]/)[0] ?? "";
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\") || UN_CONTROLE.test(p)) return null;
  if (p.length > 1) p = p.replace(/\/+$/, "") || "/";
  return p.length <= 300 ? p : null;
}

/** La cible d'un clic : l'adresse sans ses paramètres (ni jeton ni e-mail en paramètre), ou un texte court. */
export function normaliserCible(v: unknown): string | null {
  const s = texte(v, 400);
  if (!s) return null;
  if (/^(tel|mailto|sms):/i.test(s)) return s.split("?")[0]!.slice(0, 120);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 200);
    } catch {
      return null;
    }
  }
  if (s.startsWith("/")) return normaliserChemin(s);
  return s.slice(0, 80);
}

/**
 * LIT UN ÉVÉNEMENT envoyé par le navigateur — strictement : un type de la liste, un chemin relatif,
 * des longueurs bornées. Ce qui ne passe pas est ignoré (`null`), jamais corrigé à l'aveugle.
 */
export function validerEvenement(brut: unknown): EvenementValide | null {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return null;
  const o = brut as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type.toUpperCase() : "";
  if (!(TYPES_EVENEMENT as readonly string[]).includes(type)) return null;
  const path = normaliserChemin(o.path);
  if (!path) return null;

  const session = typeof o.session === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(o.session) ? o.session : null;
  let label: string | null = null;
  let target: string | null = null;
  let durationMs: number | null = null;
  if (type === "CLICK") {
    const l = typeof o.label === "string" ? o.label.trim().toLowerCase() : "";
    label = l.length <= LABEL_MAX && /^[a-z0-9][a-z0-9_-]*$/.test(l) ? l : "cta";
    target = normaliserCible(o.target);
  }
  if (type === "LEAVE") {
    const d = typeof o.durationMs === "number" ? o.durationMs : Number.NaN;
    if (!Number.isFinite(d) || d <= 0) return null;
    durationMs = Math.min(DUREE_MAX_MS, Math.round(d));
  }
  const medium = texte(o.utmMedium, 60);
  return {
    type: type as TypeEvenement,
    path,
    title: type === "PAGEVIEW" ? texte(o.title, 200) : null,
    referrer: hoteDuReferent(typeof o.referrer === "string" ? o.referrer : null),
    utmSource: texte(o.utmSource, 60),
    medium: medium ? medium.toLowerCase() : null,
    campaign: texte(o.utmCampaign, 100),
    session,
    label,
    target,
    durationMs,
  };
}

/** Le lot : `{ events: [...] }` ou un tableau nu ; au plus `LOT_MAX` événements valides. */
export function validerLot(brut: unknown): EvenementValide[] {
  const liste = Array.isArray(brut)
    ? brut
    : brut && typeof brut === "object" && Array.isArray((brut as { events?: unknown }).events)
      ? (brut as { events: unknown[] }).events
      : [];
  const out: EvenementValide[] = [];
  for (const e of liste.slice(0, LOT_MAX)) {
    const v = validerEvenement(e);
    if (v) out.push(v);
  }
  return out;
}

/** Le pays donné par l'hébergeur (code ISO à deux lettres), sinon rien. */
export function paysDepuisEntetes(get: (nom: string) => string | null): string | null {
  for (const nom of ["cf-ipcountry", "x-vercel-ip-country", "x-country"]) {
    const v = (get(nom) ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1") return v;
  }
  return null;
}

// ───────────────────────────── Les périodes ─────────────────────────────

export const PERIODES = [
  { cle: "7j", libelle: "7 j", jours: 7 },
  { cle: "30j", libelle: "30 j", jours: 30 },
  { cle: "90j", libelle: "90 j", jours: 90 },
  { cle: "12m", libelle: "12 mois", jours: 0 },
] as const;
export type ClePeriode = (typeof PERIODES)[number]["cle"];

export function lirePeriode(v: string | string[] | undefined | null): ClePeriode {
  const s = Array.isArray(v) ? v[0] : v;
  return (PERIODES.find((p) => p.cle === s)?.cle ?? "30j") as ClePeriode;
}

/** L'heure d'Alger (UTC+1, sans changement d'heure) : les jours se coupent à minuit, là-bas. */
const DECALAGE_ALGER_MS = 3_600_000;
const JOUR_MS = 86_400_000;

export interface Bornes {
  debut: Date;
  fin: Date;
  /**
   * La période précédente, de la MÊME durée écoulée : un mardi midi, « 7 j » se compare aux sept
   * jours d'avant arrêtés au mardi midi précédent — pas à une semaine pleine contre une entamée.
   */
  debutPrecedent: Date;
  finPrecedent: Date;
  granularite: "jour" | "mois";
}

/** Minuit (Alger) du jour de `t`, exprimé en instant UTC. */
function minuitAlger(t: number): number {
  return Math.floor((t + DECALAGE_ALGER_MS) / JOUR_MS) * JOUR_MS - DECALAGE_ALGER_MS;
}

/**
 * LA PÉRIODE ET CELLE QUI LA PRÉCÈDE, de même longueur. « 7 j » = aujourd'hui et les six jours
 * d'avant ; « 12 mois » = le mois en cours et les onze d'avant, compté au mois.
 */
export function bornesPeriode(cle: ClePeriode, maintenant: Date = new Date()): Bornes {
  const t = maintenant.getTime();
  if (cle === "12m") {
    const a = new Date(t + DECALAGE_ALGER_MS);
    const debut = Date.UTC(a.getUTCFullYear(), a.getUTCMonth() - 11, 1) - DECALAGE_ALGER_MS;
    const debutPrecedent = Date.UTC(a.getUTCFullYear(), a.getUTCMonth() - 23, 1) - DECALAGE_ALGER_MS;
    return {
      debut: new Date(debut), fin: maintenant, debutPrecedent: new Date(debutPrecedent),
      finPrecedent: new Date(Math.min(debut, debutPrecedent + (t - debut))), granularite: "mois",
    };
  }
  const jours = PERIODES.find((p) => p.cle === cle)!.jours;
  const debut = minuitAlger(t) - (jours - 1) * JOUR_MS;
  const debutPrecedent = debut - jours * JOUR_MS;
  return {
    debut: new Date(debut), fin: maintenant, debutPrecedent: new Date(debutPrecedent),
    finPrecedent: new Date(debutPrecedent + (t - debut)), granularite: "jour",
  };
}

/** Le nom d'un pays en français (« DZ » → « Algérie »), le code lui-même à défaut. */
export function nomDuPays(code: string | null): string {
  if (!code || !/^[A-Z]{2}$/.test(code)) return code || "Inconnu";
  try {
    return new Intl.DisplayNames(["fr"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** La clé de seau d'un instant — la même que celle que la base calcule (`to_char`, heure d'Alger). */
export function cleDeSeau(at: Date, granularite: "jour" | "mois"): string {
  const iso = new Date(at.getTime() + DECALAGE_ALGER_MS).toISOString();
  return granularite === "mois" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** Tous les seaux de la période, dans l'ordre — un jour sans visite est un zéro, pas un trou. */
export function seauxDeLaPeriode(b: Bornes): string[] {
  const out: string[] = [];
  if (b.granularite === "mois") {
    const a = new Date(b.debut.getTime() + DECALAGE_ALGER_MS);
    for (let i = 0; i < 12; i++) out.push(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    return out;
  }
  for (let t = b.debut.getTime(); t < b.fin.getTime(); t += JOUR_MS) out.push(cleDeSeau(new Date(t), "jour"));
  return out;
}

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « 07/10 » pour un jour, « oct. 26 » pour un mois. */
export function libelleDeSeau(cle: string): string {
  if (/^\d{4}-\d{2}$/.test(cle)) return `${MOIS_COURTS[Number(cle.slice(5, 7)) - 1]} ${cle.slice(2, 4)}`;
  return `${cle.slice(8, 10)}/${cle.slice(5, 7)}`;
}

/** Remplit la série : chaque seau de la période, avec ses valeurs ou des zéros. */
export function serieComplete<T extends { seau: string }>(
  seaux: string[], lignes: T[], vide: (seau: string) => T,
): T[] {
  const parSeau = new Map(lignes.map((l) => [l.seau, l]));
  return seaux.map((s) => parSeau.get(s) ?? vide(s));
}

// ───────────────────────────── Les calculs de l'écran ─────────────────────────────

/** Un taux en %, `null` quand le dénominateur est nul (on n'invente pas un 0 %). */
export function taux(numerateur: number, denominateur: number): number | null {
  if (!denominateur) return null;
  return (numerateur / denominateur) * 100;
}

export interface Variation {
  /** En % (pour un compte) ou en points (pour un taux). */
  valeur: number | null;
  texte: string | null;
  /** Le sens du mieux : une hausse du rebond est une mauvaise nouvelle. */
  favorable: boolean | null;
}

function signe(n: number, unite: string, decimales: number): string {
  const v = Math.abs(n).toLocaleString("fr-FR", { maximumFractionDigits: decimales, minimumFractionDigits: 0 });
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${v} ${unite}`;
}

/** La variation d'un compte par rapport à la période précédente, en %. Rien si celle-ci était à zéro. */
export function variation(courant: number, precedent: number, plusEstMieux = true): Variation {
  if (!precedent) return { valeur: null, texte: null, favorable: null };
  const v = Math.round(((courant - precedent) / precedent) * 100);
  return { valeur: v, texte: signe(v, "%", 0), favorable: v === 0 ? null : (v > 0) === plusEstMieux };
}

/** L'écart d'un TAUX en points (« +1,2 pt »), rien si l'un des deux n'existe pas. */
export function ecartPoints(courant: number | null, precedent: number | null, plusEstMieux = true): Variation {
  if (courant === null || precedent === null) return { valeur: null, texte: null, favorable: null };
  const v = Math.round((courant - precedent) * 10) / 10;
  return { valeur: v, texte: signe(v, "pt", 1), favorable: v === 0 ? null : (v > 0) === plusEstMieux };
}

/** Le taux de rebond : la part des visites qui n'ont vu qu'UNE page. */
export function tauxDeRebond(visitesAUnePage: number, visites: number): number | null {
  return taux(visitesAUnePage, visites);
}

/** « 1 min 24 s », « 42 s », « — » pour rien. */
export function formatDuree(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** « il y a 4 min », « il y a 3 h », « il y a 2 j » — l'âge du dernier événement reçu. */
export function ilYA(at: Date, maintenant: Date = new Date()): string {
  const s = Math.max(0, Math.round((maintenant.getTime() - at.getTime()) / 1000));
  if (s < 60) return "il y a moins d'une minute";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export function formatTaux(p: number | null): string {
  if (p === null) return "—";
  return `${p.toLocaleString("fr-FR", { maximumFractionDigits: p < 10 ? 1 : 0 })} %`;
}

/**
 * LE SLUG D'UNE PAGE sous un préfixe : `/carrieres/delegue-alger/postuler` → `delegue-alger`.
 * `null` pour la page d'index (`/carrieres`) ou un autre préfixe.
 */
export function slugSous(path: string, prefixe: "carrieres" | "blog"): string | null {
  const m = new RegExp(`^/(?:[a-z]{2}/)?${prefixe}/([^/]+)`, "i").exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return m[1]!.toLowerCase();
  }
}

/** Le slug porté par l'adresse que le site a rendue (`/carrieres/x`, `https://…/blog/x`). */
export function slugDeLAdresse(url: string | null, prefixe: "carrieres" | "blog"): string | null {
  if (!url) return null;
  let chemin = url;
  if (/^https?:\/\//i.test(url)) {
    try {
      chemin = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  return slugSous(chemin, prefixe);
}
