/**
 * LES FILTRES D'UNE FEUILLE, COMME DANS EXCEL — module PUR (aucun import), donc testé et partagé
 * par toutes les tables de l'ERP qui se lisent comme un tableur (annuaires d'abord).
 *
 * ── CE QUE LA DIRECTION A DEMANDÉ (recette du 23/11) ─────────────────────────────────────────
 *
 * « Dans l'annuaire, je veux que l'UI/UX ressemble plus à Excel, dans le filtrage et
 * l'utilisation. » Excel, c'est un FILTRE AUTOMATIQUE par colonne : la liste des valeurs
 * distinctes, des cases à cocher, « (Tout sélectionner) », « (Vides) », et une recherche dans la
 * liste. Les filtres de deux colonnes se cumulent (ET), et la liste d'une colonne ne propose que
 * les valeurs qui restent une fois les AUTRES filtres posés — on ne coche pas « Oran » quand le
 * filtre « Cardiologie » n'y laisse personne.
 *
 * ── LE CONTRAT ───────────────────────────────────────────────────────────────────────────────
 *
 *   - une feuille dit, pour une ligne et une colonne, la valeur AFFICHÉE (`Acces`) : on filtre et
 *     l'on trie sur ce qu'on voit (« Professeur », « Alger »), jamais sur un code interne ;
 *   - un filtre de colonne est la liste des valeurs RETENUES ; une colonne absente n'est pas
 *     filtrée, une liste vide ne laisse rien passer ;
 *   - une cellule vide (ou faite d'espaces) vaut le jeton `VIDE` — « (Vides) » à l'écran ;
 *   - le tri compare comme un humain (« 9 » avant « 10 », « é » comme « e ») et range les vides
 *     EN BAS dans les deux sens, comme Excel ;
 *   - la recherche globale exige TOUS les mots tapés, accents et majuscules mis à part.
 */

/** Le jeton des cellules vides — « (Vides) » dans la liste d'un filtre. Aucun texte affiché ne le contient. */
export const VIDE = "\u0000vides";

export type Sens = "asc" | "desc";

export interface Tri {
  cle: string;
  sens: Sens;
}

/** Colonne → valeurs RETENUES (affichées, ou `VIDE`). Une colonne absente n'est pas filtrée. */
export type Filtres = Readonly<Record<string, readonly string[]>>;

/** La valeur AFFICHÉE d'une cellule. */
export type Acces<T> = (ligne: T, cle: string) => string;

export interface EtatFeuille {
  recherche: string;
  filtres: Filtres;
  tri: Tri | null;
}

export interface ValeurDistincte {
  /** La valeur telle qu'affichée, ou `VIDE`. */
  valeur: string;
  /** Le nombre de lignes qui la portent. */
  nombre: number;
}

/** Accents, majuscules et espaces multiples mis à part : « Médéa » = « medea ». */
export function plier(texte: string): string {
  return texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Le jeton d'une cellule dans un filtre : sa valeur sans espaces autour, ou `VIDE`. */
export function jeton(valeur: string | null | undefined): string {
  const v = (valeur ?? "").trim();
  return v === "" ? VIDE : v;
}

const COLLATEUR = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/** L'ordre d'Excel sur deux valeurs affichées — vides en bas, quel que soit le sens. */
export function comparer(a: string, b: string, sens: Sens = "asc"): number {
  const va = a.trim() === "";
  const vb = b.trim() === "";
  if (va || vb) return va === vb ? 0 : va ? 1 : -1;
  const c = COLLATEUR.compare(a, b);
  return sens === "asc" ? c : -c;
}

/** La ligne passe-t-elle les filtres de colonne (sauf, le cas échéant, celui de `sauf`) ? */
function passeFiltres<T>(ligne: T, filtres: Filtres, acces: Acces<T>, sauf?: string): boolean {
  for (const cle of Object.keys(filtres)) {
    if (cle === sauf) continue;
    const retenues = filtres[cle];
    if (!retenues) continue;
    if (!retenues.includes(jeton(acces(ligne, cle)))) return false;
  }
  return true;
}

/** Les mots de la recherche globale, pliés — tous doivent se trouver dans la ligne. */
function motsDe(recherche: string): string[] {
  return plier(recherche).split(" ").filter(Boolean);
}

/**
 * LES LIGNES QUE LA FEUILLE MONTRE, dans l'ordre où elle les montre.
 *
 * `bottes[i]` est le texte PLIÉ de `lignes[i]` sur lequel porte la recherche globale — calculé une
 * fois par l'écran, pas à chaque frappe. `sauf` ignore le filtre d'une colonne (c'est ainsi que la
 * liste de cette colonne se construit). Le tri est STABLE : à égalité, l'ordre du serveur demeure.
 */
export function filtrerEtTrier<T>(
  lignes: readonly T[], etat: EtatFeuille, acces: Acces<T>, bottes?: readonly string[], sauf?: string,
): T[] {
  const mots = motsDe(etat.recherche);
  const garde: T[] = [];
  lignes.forEach((ligne, i) => {
    if (mots.length > 0) {
      const botte = bottes?.[i] ?? "";
      if (!mots.every((m) => botte.includes(m))) return;
    }
    if (passeFiltres(ligne, etat.filtres, acces, sauf)) garde.push(ligne);
  });
  const tri = etat.tri;
  if (!tri) return garde;
  return garde
    .map((ligne, i) => ({ ligne, i, v: acces(ligne, tri.cle) }))
    .sort((a, b) => comparer(a.v, b.v, tri.sens) || a.i - b.i)
    .map((x) => x.ligne);
}

/** Les valeurs distinctes d'une colonne, triées comme Excel les liste — « (Vides) » en dernier. */
export function valeursDistinctes<T>(lignes: readonly T[], cle: string, acces: Acces<T>): ValeurDistincte[] {
  const compte = new Map<string, number>();
  for (const l of lignes) {
    const j = jeton(acces(l, cle));
    compte.set(j, (compte.get(j) ?? 0) + 1);
  }
  return [...compte.entries()]
    .map(([valeur, nombre]) => ({ valeur, nombre }))
    .sort((a, b) => comparer(a.valeur === VIDE ? "" : a.valeur, b.valeur === VIDE ? "" : b.valeur));
}

/**
 * LE FILTRE QUE DONNENT LES CASES COCHÉES — `null` quand tout est coché : une colonne dont on garde
 * tout n'est pas filtrée (son en-tête ne doit pas se marquer « filtré »).
 */
export function filtreDesCoches(toutes: readonly string[], cochees: ReadonlySet<string>): string[] | null {
  const retenues = toutes.filter((v) => cochees.has(v));
  return retenues.length === toutes.length ? null : retenues;
}

/** Le filtre d'une colonne posé (ou retiré par `null`), les autres intacts. */
export function avecFiltre(filtres: Filtres, cle: string, retenues: readonly string[] | null): Filtres {
  const autres: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(filtres)) if (k !== cle) autres[k] = v;
  if (retenues !== null) autres[cle] = retenues;
  return autres;
}

/** Le clic sur un en-tête : croissant, puis décroissant, puis l'ordre d'origine. */
export function triSuivant(tri: Tri | null, cle: string): Tri | null {
  if (!tri || tri.cle !== cle) return { cle, sens: "asc" };
  return tri.sens === "asc" ? { cle, sens: "desc" } : null;
}

const NOMBRE = new Intl.NumberFormat("fr-FR");

/** « 1 234 lignes » ; « 1 234 lignes (56 filtrées) » dès qu'un filtre ou une recherche réduit la vue. */
export function libelleCompte(total: number, visibles: number, filtre: boolean): string {
  const base = `${NOMBRE.format(total)} ligne${total > 1 ? "s" : ""}`;
  if (!filtre) return base;
  return `${base} (${NOMBRE.format(visibles)} filtrée${visibles > 1 ? "s" : ""})`;
}
