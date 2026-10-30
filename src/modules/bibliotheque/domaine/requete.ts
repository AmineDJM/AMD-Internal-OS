import { estFamille, type Famille } from "./familles";
import { estFormat, type Format } from "./format";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REQUÊTE ET SES FILTRES — lus, bornés, validés (J1). Pur.
 *
 * Une requête arrive d'un écran (paramètres d'URL) ou d'un outil (objet). Ce module la ramène à une
 * forme sûre : texte borné, filtres connus seulement (un format inconnu est ignoré, pas inventé),
 * période ordonnée, limite plafonnée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SOURCES = ["DRIVE", "CONVERSATION", "EMAIL", "PORTAIL", "AD_PRO", "RH", "LEGAL", "AUTRE"] as const;
export type Source = (typeof SOURCES)[number];
export const LIBELLES_SOURCES: Record<Source, string> = {
  DRIVE: "Drive", CONVERSATION: "Conversations", EMAIL: "Courriels", PORTAIL: "Portail", AD_PRO: "Ad & Pro",
  RH: "RH", LEGAL: "Juridique", AUTRE: "Autres modules",
};

export const LIMITE_DEFAUT = 20;
export const LIMITE_MAX = 50;
export const LONGUEUR_REQUETE_MAX = 300;

export interface Filtres {
  formats?: Format[];
  sources?: Source[];
  /** Date de la pièce (dépôt), bornes incluses. */
  du?: Date;
  au?: Date;
  /** Une clé d'accès précise (« DRIVE_NODE:… ») : seulement les pièces rangées à cet endroit. */
  objet?: string;
  /** Une famille d'endroits (« DOCUMENT », « MESSAGE_PIECE »). */
  familles?: Famille[];
}

export interface RequeteNormalisee {
  texte: string;
  filtres: Filtres;
  limite: number;
}

const estSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);

function date(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00Z` : v.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function liste(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => liste(x));
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function normaliserRequete(texte: string, filtres: {
  formats?: unknown; sources?: unknown; du?: unknown; au?: unknown; objet?: unknown; familles?: unknown;
} = {}, limite?: number): RequeteNormalisee {
  const f: Filtres = {};
  const formats = liste(filtres.formats).filter(estFormat);
  if (formats.length) f.formats = [...new Set(formats)];
  const sources = liste(filtres.sources).filter(estSource);
  if (sources.length) f.sources = [...new Set(sources)];
  const familles = liste(filtres.familles).filter(estFamille);
  if (familles.length) f.familles = [...new Set(familles)];
  const jour = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
  let du = date(filtres.du);
  let au = date(filtres.au);
  let auEstUnJour = jour(filtres.au);
  if (du && au && du > au) {
    [du, au] = [au, du];
    auEstUnJour = jour(filtres.du);
  }
  // « au 2026-10-29 » inclut toute la journée.
  if (au && auEstUnJour) au = new Date(au.getTime() + 86_400_000 - 1);
  if (du) f.du = du;
  if (au) f.au = au;
  if (typeof filtres.objet === "string" && /^[A-Z_]+:[^\s:]+$/.test(filtres.objet.trim())) f.objet = filtres.objet.trim();
  const n = Number.isFinite(limite) ? Math.floor(limite as number) : LIMITE_DEFAUT;
  return {
    texte: (texte ?? "").replace(/\s+/g, " ").trim().slice(0, LONGUEUR_REQUETE_MAX),
    filtres: f,
    limite: Math.min(LIMITE_MAX, Math.max(1, n)),
  };
}
