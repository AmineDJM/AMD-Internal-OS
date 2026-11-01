/**
 * LES FILTRES D'UN EXPORT, lus depuis une entrée libre (paramètres d'URL de l'écran, arguments du modèle) — PUR.
 *
 * Un filtre se donne comme à l'écran : la clé (« AWAITING_ANPP ») ou le libellé affiché (« Attente ANPP »), accents et
 * casse indifférents. Un libellé qui ne désigne rien est rendu tel quel au refus — jamais deviné.
 */

export const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Table = Readonly<Record<string, string | { label: string }>>;
const libelle = (v: string | { label: string }) => (typeof v === "string" ? v : v.label);

/** La clé d'une table de libellés désignée par sa clé ou son libellé ; `undefined` si rien ne correspond. */
export function cleParLibelle(table: Table, saisie: string): string | undefined {
  const s = plier(saisie);
  if (!s) return undefined;
  const entrees = Object.entries(table);
  return entrees.find(([k]) => plier(k) === s)?.[0]
    ?? entrees.find(([, v]) => plier(libelle(v)) === s)?.[0]
    ?? entrees.find(([, v]) => plier(libelle(v)).includes(s))?.[0];
}

/** Les libellés d'une table, pour dire au modèle (et à la personne) ce qui est attendu. */
export const libellesDe = (table: Table): string => Object.values(table).map(libelle).join(", ");

export const texte = (e: Readonly<Record<string, unknown>>, k: string): string => {
  const v = e[k];
  return typeof v === "string" ? v.trim().slice(0, 300) : typeof v === "number" ? String(v) : "";
};

export const liste = (e: Readonly<Record<string, unknown>>, k: string): string[] => {
  const v = e[k];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).slice(0, 5000);
  return typeof v === "string" && v.trim() ? v.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
};

export const entier = (e: Readonly<Record<string, unknown>>, k: string): number | null => {
  const n = Number(e[k]);
  return Number.isInteger(n) ? n : null;
};

/** Une date AAAA-MM-JJ (ou ISO) ; tout le reste → `null` (le filtre ne s'applique pas, il ne se devine pas). */
export const date = (e: Readonly<Record<string, unknown>>, k: string): Date | null => {
  const t = texte(e, k);
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Un identifiant de base (cuid) — sinon, c'est un NOM à résoudre dans la portée de la personne. */
export const estIdentifiant = (t: string): boolean => /^c[a-z0-9]{20,}$/.test(t);
