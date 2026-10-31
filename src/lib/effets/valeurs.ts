/**
 * LES VALEURS D'UNE ÉCRITURE, SÉRIALISÉES (J7, décision 0029) — pur, sans import : le journal, le diff de la carte et
 * l'annulation comparent la MÊME forme.
 *
 * Une date devient `{ $date: iso }`, un décimal `{ $decimal: "12.50" }`, un entier long `{ $bigint }`, des octets
 * `{ $octets: n }` (jamais recopiés : une pièce ne se journalise pas deux fois — elle ne se restaure donc pas depuis
 * le journal). Une valeur JSON garde sa forme ; la comparaison passe par `cleDeValeur`, aux clés triées (Postgres
 * réordonne les clés d'un `jsonb`).
 */

export type ValeurSerialisee = unknown;

const estDecimal = (v: object): v is { toFixed: () => string; d: unknown } =>
  typeof (v as { toFixed?: unknown }).toFixed === "function" && "d" in v && "e" in v && "s" in v;

export function serialiser(v: unknown): ValeurSerialisee {
  if (v === undefined) return null;
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? null : v.toISOString() };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return { $octets: v.length };
  if (v instanceof Uint8Array) return { $octets: v.byteLength };
  if (Array.isArray(v)) return v.map(serialiser);
  if (typeof v === "object") {
    if (estDecimal(v)) return { $decimal: (v as { toString: () => string }).toString() };
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, serialiser(x)]));
  }
  return String(v);
}

export function serialiserLigne(ligne: Record<string, unknown> | null | undefined, garder?: ReadonlySet<string>): Record<string, unknown> | null {
  if (!ligne) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ligne)) {
    if (garder && !garder.has(k)) continue;
    out[k] = serialiser(v);
  }
  return out;
}

/** La clé de comparaison d'une valeur sérialisée — stable (clés triées), pour dire « encore la même valeur ». */
export function cleDeValeur(v: ValeurSerialisee): string {
  const trie = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(trie);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, trie((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  // Un décimal se compare par sa valeur : « 12.5 » et « 12.50 » sont le même montant.
  if (v && typeof v === "object" && "$decimal" in v) return `dec:${Number((v as { $decimal: string }).$decimal)}`;
  return JSON.stringify(trie(v ?? null));
}

export const memeValeur = (a: ValeurSerialisee, b: ValeurSerialisee): boolean => cleDeValeur(a) === cleDeValeur(b);

/** Une valeur sérialisée, en mots courts pour l'écran : « 12 novembre 2026 », « vide », « [3 éléments] ». */
export function valeurLisible(v: ValeurSerialisee): string {
  if (v === null || v === undefined || v === "") return "vide";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  if (Array.isArray(v)) return v.length === 0 ? "vide" : v.every((x) => typeof x === "string") && v.length <= 3 ? v.join(", ") : `[${v.length} éléments]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$date === "string") {
      const d = new Date(o.$date);
      const heure = d.getUTCHours() || d.getUTCMinutes() ? ` ${d.toISOString().slice(11, 16)}` : "";
      return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}${heure}`;
    }
    if (typeof o.$decimal === "string") return o.$decimal;
    if (typeof o.$bigint === "string") return o.$bigint;
    if (typeof o.$octets === "number") return `${o.$octets} octets`;
    return "{…}";
  }
  return String(v);
}

/** Les champs dont la valeur diffère entre deux lignes sérialisées. */
export function champsChanges(avant: Record<string, unknown> | null, apres: Record<string, unknown> | null): string[] {
  const cles = new Set([...Object.keys(avant ?? {}), ...Object.keys(apres ?? {})]);
  return [...cles].filter((k) => !memeValeur(avant?.[k] ?? null, apres?.[k] ?? null)).sort();
}
