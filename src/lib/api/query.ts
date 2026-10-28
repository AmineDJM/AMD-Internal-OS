import { Prisma } from "@prisma/client";
import { errors } from "./errors";
import type { EntityDef } from "./registry/entities";

/**
 * LECTURE GÉNÉRIQUE : pagination, filtres, tri, sérialisation.
 *
 * Un agent qui analyse un portefeuille ne doit pas faire trois cents requêtes. Les listes
 * acceptent donc de gros lots — mais la pagination reste OBLIGATOIRE : une réponse non bornée
 * finit toujours par dépasser la mémoire du client ou le temps de la requête, et l'agent n'a
 * alors ni la donnée ni le moyen de savoir ce qui manque.
 *
 * Module PUR — testé.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export interface Page {
  limit: number;
  offset: number;
}

export function parsePage(params: URLSearchParams): Page {
  const limit = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const offset = Number(params.get("offset") ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0,
  };
}

/** Tri : `sort=updatedAt:desc`. Un champ inconnu est refusé plutôt qu'ignoré en silence. */
export function parseSort(raw: string | null, def: EntityDef, allowed: Set<string>): Record<string, "asc" | "desc"> {
  if (!raw) return def.orderBy ?? { id: "asc" };
  const [field, dir] = raw.split(":");
  if (!allowed.has(field)) {
    throw errors.validation(`Tri impossible sur « ${field} » : ce champ n'existe pas sur ${def.name}.`, { sort: "champ inconnu" });
  }
  return { [field]: dir === "asc" ? "asc" : "desc" };
}

/**
 * Filtres structurés passés en paramètres d'URL.
 *
 * `status=SUBMITTED` (égalité), `status=in:A,B` (liste), `updatedAt=gte:2026-01-01` (plage),
 * `dci=contains:parac` (texte), `responsibleId=null` (absence). Un champ inconnu est REFUSÉ :
 * un filtre ignoré rendrait plus de lignes que demandé sans que l'agent s'en aperçoive — et
 * c'est ainsi qu'on prend une liste partielle pour la réalité.
 */
export function parseFilters(params: URLSearchParams, allowed: Set<string>, reserved: Set<string>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [key, raw] of params.entries()) {
    if (reserved.has(key)) continue;
    if (!allowed.has(key)) {
      throw errors.validation(`Filtre impossible sur « ${key} » : ce champ n'existe pas sur cet objet.`, { [key]: "champ inconnu" });
    }
    where[key] = parseFilterValue(raw);
  }
  return where;
}

export function parseFilterValue(raw: string): unknown {
  if (raw === "null") return null;
  const m = /^(in|nin|gte|gt|lte|lt|contains|startsWith|not)\s*:\s*([\s\S]*)$/.exec(raw);
  if (!m) return coerce(raw);
  const [, op, value] = m;
  switch (op) {
    case "in": return { in: value.split(",").map((v) => coerce(v.trim())) };
    case "nin": return { notIn: value.split(",").map((v) => coerce(v.trim())) };
    case "contains": return { contains: value, mode: "insensitive" };
    case "startsWith": return { startsWith: value, mode: "insensitive" };
    case "not": return { not: coerce(value) };
    default: return { [op]: coerce(value) };
  }
}

/** « true » est un booléen, « 2026-01-01 » une date, « 12 » un nombre — sinon du texte. */
function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return v;
}

/** Recherche plein texte sur les champs déclarés de l'objet. */
export function textSearchWhere(def: EntityDef, q: string): Record<string, unknown> {
  if (!q || def.searchFields.length === 0) return {};
  return { OR: def.searchFields.map((f) => ({ [f]: { contains: q, mode: "insensitive" } })) };
}

/**
 * Rend un objet Prisma sérialisable en JSON.
 *
 * Les `Decimal` deviennent des NOMBRES (un agent qui compare un montant à un objet
 * `{s,e,d}` se trompe), les dates des chaînes ISO, les `BigInt` des chaînes — JSON n'en a pas.
 */
/**
 * CE QUE L'API NE REND JAMAIS, quelle que soit la route, la profondeur ou la portée de l'identité :
 * secrets de connexion, identité civile, banque, rémunération. Une fiche sans `detailFields` rend
 * tout le modèle et une relation (`related`) rend ses lignes entières — c'est ainsi que
 * `employee/:id` rendait IBAN, NIN et salaires, et `user/:id` le `passwordHash` (audit refonte W10,
 * 27/10). Le filtre vit donc ICI, dans la seule fonction par laquelle toute réponse passe.
 * Le coffre de la refonte (P5) en sera la source ; d'ici là, la liste est fermée et testée.
 */
const CHAMPS_JAMAIS_EXPOSES = new Set([
  "passwordHash", "passwordEnc", "secret", "token", "publicToken", "qrToken", "keyHash",
  "iban", "rib", "nationalId", "cnasNumber",
  "baseSalary", "grossSalary", "netToPay", "employerCost",
  // La paie au-delà du salaire de base (audit sécurité 27/10) : les retenues de la fiche suffisaient à
  // recalculer le salaire, et `employee/:id/related` rendait les bulletins (`payrolls`) mois par mois.
  // Noms vérifiés uniques aux modèles de paie dans `schema.prisma`.
  "retIrg", "retSS9", "retSS35", "tfp", "expenseRefund",
  "gross", "net", "bonuses", "deductions",
  "birthDate",
]);
/** Jetons et mots de passe chiffrés au repos (`accessTokenEnc`, `refreshTokenEnc`…). */
const CHIFFRE_AU_REPOS = /Enc$/;

export const champJamaisExpose = (cle: string): boolean => CHAMPS_JAMAIS_EXPOSES.has(cle) || CHIFFRE_AU_REPOS.test(cle);

export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return Number(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === "object") {
    if (Buffer.isBuffer(value)) return undefined; // jamais d'octets bruts dans une réponse JSON
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (champJamaisExpose(k)) continue;
      const s = serialize(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return value;
}

/** Enveloppe de liste : de quoi paginer sans deviner. */
export interface ListResult<T> {
  items: T[];
  page: { limit: number; offset: number; total: number; hasMore: boolean };
}

export function listResult<T>(items: T[], total: number, page: Page): ListResult<T> {
  return {
    items,
    page: { limit: page.limit, offset: page.offset, total, hasMore: page.offset + items.length < total },
  };
}

/** `select` Prisma à partir d'une liste de champs. Vide = tout le modèle. */
export function selectOf(fields: string[] | undefined): Record<string, true> | undefined {
  if (!fields || fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((f) => [f, true as const]));
}
