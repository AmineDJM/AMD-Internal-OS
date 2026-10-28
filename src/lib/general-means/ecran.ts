import { plier } from "@/lib/utils";
/**
 * MOYENS GÉNÉRAUX — L'ÉCRAN ALLÉGÉ (Direction, 09/10) : les règles PURES des dépenses rangées par mois, des chiffres du
 * mois, de la répartition par nature et des filtres. Aucun import : lu par la requête (la « nature » d'une dépense), par
 * les composants clients (regroupement, filtres) et testé.
 *
 * Les mois sont lus en UTC, comme les séries des budgets : une même dépense tombe dans le même mois partout.
 */

/** Ce qu'on affiche quand une dépense n'est rangée dans aucune catégorie du budget. */
export const SANS_NATURE = "Non classé";

const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"] as const;

/** « AAAA-MM » (UTC) d'une date ISO ou d'un `Date`. */
export function moisCle(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "0000-00";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** « 2026-10 » → « Octobre 2026 ». */
export function titreMois(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const nom = m ? MOIS[Number(m[2]) - 1] : undefined;
  return m && nom ? `${nom} ${m[1]}` : "Date inconnue";
}

/** Le mois d'avant, « AAAA-MM » (gère le passage d'année). */
export function moisPrecedent(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface DepenseDatee { date: string; amount: number }

export interface GroupeMois<T> {
  mois: string;
  count: number;
  total: number;
  /** Les dépenses du mois, la plus récente d'abord. */
  lignes: T[];
  /** Ouvert d'office : le mois en cours seulement (à défaut de dépense ce mois-ci, le plus récent). */
  ouvert: boolean;
}

/** LES DÉPENSES PAR MOIS, le plus récent d'abord. Seul le mois en cours s'ouvre d'office. */
export function grouperParMois<T extends DepenseDatee>(rows: readonly T[], maintenant: Date | string): GroupeMois<T>[] {
  const courant = moisCle(maintenant);
  const par = new Map<string, T[]>();
  for (const r of rows) {
    const k = moisCle(r.date);
    par.set(k, [...(par.get(k) ?? []), r]);
  }
  const groupes: GroupeMois<T>[] = [...par.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([mois, lignes]) => ({
      mois,
      count: lignes.length,
      total: lignes.reduce((a, r) => a + r.amount, 0),
      lignes: [...lignes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      ouvert: mois === courant,
    }));
  if (groupes.length > 0 && !groupes.some((g) => g.ouvert)) groupes[0].ouvert = true;
  return groupes;
}

/** Le dépensé du mois en cours face à celui du mois d'avant. */
export function totauxDuMois(rows: readonly DepenseDatee[], maintenant: Date | string): { mois: string; courant: number; precedentMois: string; precedent: number } {
  const mois = moisCle(maintenant);
  const precedentMois = moisPrecedent(mois);
  let courant = 0;
  let precedent = 0;
  for (const r of rows) {
    const k = moisCle(r.date);
    if (k === mois) courant += r.amount;
    else if (k === precedentMois) precedent += r.amount;
  }
  return { mois, courant, precedentMois, precedent };
}

/**
 * LA NATURE D'UNE DÉPENSE : la catégorie où le ticket est classé ; à défaut, celle de l'article classé le plus cher ;
 * sinon `null` (« Non classé »). `nom` donne le nom d'une catégorie par son identifiant.
 */
export function natureDeLaDepense(
  e: { budgetCategoryId: string | null; lines: readonly { amount: number; budgetCategoryId: string | null }[] },
  nom: ReadonlyMap<string, string>,
): string | null {
  if (e.budgetCategoryId) return nom.get(e.budgetCategoryId) ?? null;
  const classes = e.lines.filter((l) => l.budgetCategoryId && nom.has(l.budgetCategoryId));
  if (classes.length === 0) return null;
  const parCat = new Map<string, number>();
  for (const l of classes) parCat.set(l.budgetCategoryId as string, (parCat.get(l.budgetCategoryId as string) ?? 0) + l.amount);
  const [meilleure] = [...parCat.entries()].sort((a, b) => b[1] - a[1]);
  return nom.get(meilleure[0]) ?? null;
}

/** La part d'une dépense qui revient à une nature (`null` = « Non classé »). */
export interface PartDeNature { nature: string | null; amount: number }

/**
 * LA DÉPENSE DÉCOUPÉE PAR NATURE, ARTICLE PAR ARTICLE (Direction, 10/2026) : un ticket « café + ramettes » compte le
 * café en cuisine et les ramettes en papeterie. Chaque article classé va à sa catégorie ; le reste du ticket (articles
 * sans catégorie, écart entre le total et les articles) va à la catégorie du ticket, sinon à « Non classé ». La même
 * règle que `isFullyClassified` côté budget.
 */
export function partsParNature(
  e: { amount: number; budgetCategoryId: string | null; lines: readonly { amount: number; budgetCategoryId: string | null }[] },
  nom: ReadonlyMap<string, string>,
): PartDeNature[] {
  const par = new Map<string | null, number>();
  const ajouter = (n: string | null, m: number) => { if (m > 0) par.set(n, (par.get(n) ?? 0) + m); };
  let classe = 0;
  for (const l of e.lines) {
    const n = l.budgetCategoryId ? nom.get(l.budgetCategoryId) ?? null : null;
    if (n) { ajouter(n, l.amount); classe += l.amount; }
  }
  const reste = Math.round((e.amount - classe) * 100) / 100;
  ajouter(e.budgetCategoryId ? nom.get(e.budgetCategoryId) ?? null : null, reste);
  return [...par.entries()].map(([nature, amount]) => ({ nature, amount: Math.round(amount * 100) / 100 }));
}

/**
 * « PAR NATURE » D'UN MOIS : le total de chaque nature sur les dépenses du mois (« AAAA-MM »), la plus lourde d'abord.
 * Toutes les natures sont gardées — l'écran les veut cliquables une à une, pas repliées dans « Autres ».
 */
export function repartitionDuMois(
  rows: readonly { date: string; parts: readonly PartDeNature[] }[],
  mois: string,
): PartNature[] {
  const par = new Map<string, PartNature>();
  for (const r of rows) {
    if (moisCle(r.date) !== mois) continue;
    for (const p of r.parts) {
      const label = p.nature ?? SANS_NATURE;
      const x = par.get(label) ?? { label, total: 0, count: 0 };
      x.total = Math.round((x.total + p.amount) * 100) / 100;
      x.count += 1;
      par.set(label, x);
    }
  }
  return [...par.values()].filter((p) => p.total > 0).sort((a, b) => b.total - a.total);
}

/** Le mois suivant, « AAAA-MM ». */
export function moisSuivant(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Le mois montré d'office : le mois en cours quand on regarde l'année en cours, sinon décembre de l'année regardée
 * (une année passée se lit par sa fin), sinon janvier (une année à venir).
 */
export function moisParDefaut(annee: number, maintenant: Date | string): string {
  const courant = moisCle(maintenant);
  const a = Number(courant.slice(0, 4));
  if (annee === a) return courant;
  return annee < a ? `${annee}-12` : `${annee}-01`;
}

export interface PartNature { label: string; total: number; count: number }

/** « PAR NATURE » : le total par nature, la plus lourde d'abord ; au-delà de `max`, la queue est repliée dans « Autres ». */
export function repartitionParNature(rows: readonly { amount: number; nature: string | null }[], max = 6): PartNature[] {
  const par = new Map<string, PartNature>();
  for (const r of rows) {
    const label = r.nature ?? SANS_NATURE;
    const p = par.get(label) ?? { label, total: 0, count: 0 };
    p.total += r.amount;
    p.count += 1;
    par.set(label, p);
  }
  const triees = [...par.values()].filter((p) => p.total > 0).sort((a, b) => b.total - a.total);
  if (triees.length <= max) return triees;
  const tete = triees.slice(0, max - 1);
  const queue = triees.slice(max - 1);
  return [...tete, { label: `Autres (${queue.length})`, total: queue.reduce((a, p) => a + p.total, 0), count: queue.reduce((a, p) => a + p.count, 0) }];
}

export type FiltrePaiement = "TOUS" | "CAISSE" | "HORS";
export interface FiltresDepenses {
  recherche: string;
  paiement: FiltrePaiement;
  /** "" = toutes les natures. */
  nature: string;
  /** « AAAA-MM », "" = tous les mois — posé par un clic sur une nature de « Par nature ». */
  mois?: string;
}
export const AUCUN_FILTRE: FiltresDepenses = { recherche: "", paiement: "TOUS", nature: "", mois: "" };

/** Y a-t-il un filtre posé ? (alors tous les mois concernés s'ouvrent : on cherche, on ne feuillette pas) */
export function filtreActif(f: FiltresDepenses): boolean {
  return f.recherche.trim() !== "" || f.paiement !== "TOUS" || f.nature !== "" || Boolean(f.mois);
}

/** Les natures d'une dépense : celles de ses parts quand elles sont connues, sinon sa nature principale. */
function naturesDe(r: { nature: string | null; parts?: readonly PartDeNature[] }): string[] {
  return r.parts && r.parts.length > 0 ? r.parts.map((p) => p.nature ?? SANS_NATURE) : [r.nature ?? SANS_NATURE];
}

export function filtrerDepenses<T extends { label: string; notes: string | null; nature: string | null; parts?: readonly PartDeNature[]; date?: string; fromPettyCash: boolean; lines: readonly { label: string }[] }>(
  rows: readonly T[], f: FiltresDepenses,
): T[] {
  const mots = plier(f.recherche).split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.paiement === "CAISSE" && !r.fromPettyCash) return false;
    if (f.paiement === "HORS" && r.fromPettyCash) return false;
    if (f.nature !== "" && !naturesDe(r).includes(f.nature)) return false;
    if (f.mois && (!r.date || moisCle(r.date) !== f.mois)) return false;
    if (mots.length === 0) return true;
    const texte = plier([r.label, r.notes ?? "", r.nature ?? "", ...r.lines.map((l) => l.label)].join(" "));
    return mots.every((m) => texte.includes(m));
  });
}

/** La part dépensée d'un fond, de 0 à 100 (la barre ne dépasse jamais sa piste). */
export function partDepensee(depense: number, remis: number): number {
  if (remis <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((depense / remis) * 100)));
}
