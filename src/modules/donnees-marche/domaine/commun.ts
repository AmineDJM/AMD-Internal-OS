/**
 * DONNÉES MARCHÉ — LES PRIMITIVES DE LECTURE (pures). Un classeur arrive ici déjà découpé en feuilles de lignes brutes
 * (`unknown[][]`) : ni `xlsx`, ni Node, ni Prisma. Les deux lecteurs (nomenclature, IQVIA) s'en servent.
 */

/** Une feuille du classeur : son nom et ses lignes brutes (cellules telles que lues). */
export interface Feuille {
  nom: string;
  lignes: unknown[][];
}

/** En-tête comparable : sans accents, MAJUSCULES, blancs et retours à la ligne réduits à un espace. */
export function normEntete(v: unknown): string {
  return String(v ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

/** Texte d'une cellule, rogné ; `null` si vide. */
export function texte(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** Nombre d'une cellule ; 0 si vide ou illisible (les classeurs mettent du vide là où il n'y a pas de vente). */
export function nombre(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Nombre ou `null` (pour une croissance : absente n'est pas zéro). */
export function nombreOuNul(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = nombre(v);
  return typeof v === "number" || /\d/.test(String(v)) ? n : null;
}

/**
 * Date d'une cellule → « AAAA-MM-JJ » ou `null`. Accepte un objet Date, un numéro de série Excel (jours depuis
 * 1899-12-30) et « JJ/MM/AAAA ». Un texte qui n'est pas une date (« RETRAIT ») rend `null` — jamais une date inventée.
 */
export function dateIso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 1000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    const iso = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  return null;
}

/** L'index de la première ligne qui contient TOUS les en-têtes demandés (normalisés), ou -1. */
export function ligneEntete(lignes: unknown[][], requis: string[], max = 40): number {
  for (let i = 0; i < Math.min(lignes.length, max); i++) {
    const cellules = (lignes[i] ?? []).map(normEntete);
    if (requis.every((r) => cellules.includes(r))) return i;
  }
  return -1;
}
