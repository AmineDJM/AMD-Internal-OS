/**
 * VENTES PCH — LA LECTURE DES FICHIERS DE LA PCH (module PUR, sans base, sans `xlsx`).
 *
 * Deux natures de fichiers arrivent chaque mois (et parfois un fichier annuel) :
 *   • VENTES D'UNE DIRECTION RÉGIONALE (VENTEDRA.xls, VENTEDRO.xls…) — ce que la DR a servi aux hôpitaux,
 *     ligne par ligne : ANNEXE | FAMILLE | CLASSE | CLIENT | POSTE | DCI | UC | LOT | DDP | QTÉ_COMMANDÉE |
 *     QTÉ_LIVRÉE | COUT_ACHAT | PRIX_VENTE | DATEFACT. Une ligne livrée à 0 pour une quantité commandée = une
 *     DEMANDE NON SERVIE (rupture) ; une quantité livrée négative = un RETOUR (avoir).
 *   • RÉCEPTIONS DE LA PCH CENTRALE (Reception2025.xlsx) — ce que la PCH a reçu : GAMME | DESI_CLASSE |
 *     CODE_FOUR | NOM_FOUR | NUM_BR | CODE_PRO | DESI_PRO | CODE_COND | QTE | ROUND(P.COUT_UNIT_ACHAT,2) |
 *     CODE_MON | DATESTOCKAGE | TYPE_RECEP (FO fournisseur, TR transfert, RC retour client, CO correction) | AVOIRNO.
 *
 * Le CODE_PRO des réceptions est le POSTE des ventes (même code produit PCH — vérifié sur les fichiers réels).
 *
 * Le classeur est lu par `service.ts` (côté serveur) en lignes brutes (`unknown[][]`, valeurs brutes : les dates
 * Excel arrivent en NUMÉROS DE SÉRIE, jamais en `Date` décalée d'un fuseau) ; tout le reste se décide ici.
 */

export type NatureFichier = "VENTES_DR" | "RECEPTIONS";

/** Ce qu'une ligne de vente DIT de la demande de l'hôpital. */
export type StatutLigne = "SERVIE" | "PARTIELLE" | "NON_SERVIE" | "RETOUR" | "NULLE";

// ─────────────────────────── En-têtes ───────────────────────────

/** Une écriture d'en-tête comparable : « QTÉ_COMMANDÉE » → « QTE_COMMANDEE », « ROUND(P.COUT_UNIT_ACHAT,2) » → « ROUND_P_COUT_UNIT_ACHAT_2 ». */
export function cleEntete(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

type ChampVente = "ANNEXE" | "FAMILLE" | "CLASSE" | "CLIENT" | "POSTE" | "DCI" | "UC" | "LOT" | "DDP" | "QTE_COMMANDEE" | "QTE_LIVREE" | "COUT_ACHAT" | "PRIX_VENTE" | "DATEFACT";
type ChampReception = "GAMME" | "DESI_CLASSE" | "CODE_FOUR" | "NOM_FOUR" | "NUM_BR" | "CODE_PRO" | "DESI_PRO" | "CODE_COND" | "QTE" | "COUT_UNIT" | "CODE_MON" | "DATESTOCKAGE" | "TYPE_RECEP" | "AVOIRNO";

const CHAMPS_VENTE: ChampVente[] = ["ANNEXE", "FAMILLE", "CLASSE", "CLIENT", "POSTE", "DCI", "UC", "LOT", "DDP", "QTE_COMMANDEE", "QTE_LIVREE", "COUT_ACHAT", "PRIX_VENTE", "DATEFACT"];
const CHAMPS_RECEPTION: ChampReception[] = ["GAMME", "DESI_CLASSE", "CODE_FOUR", "NOM_FOUR", "NUM_BR", "CODE_PRO", "DESI_PRO", "CODE_COND", "QTE", "COUT_UNIT", "CODE_MON", "DATESTOCKAGE", "TYPE_RECEP", "AVOIRNO"];

/** Le champ qu'un en-tête désigne — le nom exact, ou la variante connue (le prix des réceptions est une formule SQL). */
function champDeLEntete(cle: string): string {
  if (cle.includes("COUT_UNIT")) return "COUT_UNIT";
  if (cle === "QTE_COMMANDE" || cle === "QTE_COMMANDEE" || cle === "QUANTITE_COMMANDEE") return "QTE_COMMANDEE";
  if (cle === "QTE_LIVRE" || cle === "QTE_LIVREE" || cle === "QUANTITE_LIVREE") return "QTE_LIVREE";
  return cle;
}

export type Entete =
  | { nature: "VENTES_DR"; ligne: number; index: Record<ChampVente, number> }
  | { nature: "RECEPTIONS"; ligne: number; index: Record<ChampReception, number> };

/** Les champs SANS lesquels un fichier n'est pas de cette nature. */
const REQUIS_VENTE: ChampVente[] = ["CLIENT", "POSTE", "DCI", "QTE_COMMANDEE", "QTE_LIVREE"];
const REQUIS_RECEPTION: ChampReception[] = ["NOM_FOUR", "CODE_PRO", "DESI_PRO", "QTE", "TYPE_RECEP"];

/**
 * TROUVE L'EN-TÊTE et la NATURE du fichier — dans les dix premières lignes (une ligne de titre au-dessus ne gêne pas).
 * Rien de reconnu → `null` : le fichier n'est ni des ventes d'une DR ni des réceptions, et on le dit.
 */
export function detecterEntete(lignes: readonly unknown[][]): Entete | null {
  for (let i = 0; i < Math.min(10, lignes.length); i++) {
    const cles = (lignes[i] ?? []).map((c) => champDeLEntete(cleEntete(c)));
    const pos = (champ: string) => cles.indexOf(champ);
    if (REQUIS_VENTE.every((c) => pos(c) >= 0)) {
      const index = Object.fromEntries(CHAMPS_VENTE.map((c) => [c, pos(c)])) as Record<ChampVente, number>;
      return { nature: "VENTES_DR", ligne: i, index };
    }
    if (REQUIS_RECEPTION.every((c) => pos(c) >= 0)) {
      const index = Object.fromEntries(CHAMPS_RECEPTION.map((c) => [c, pos(c)])) as Record<ChampReception, number>;
      return { nature: "RECEPTIONS", ligne: i, index };
    }
  }
  return null;
}

// ─────────────────────────── Valeurs ───────────────────────────

/** Un texte de cellule, sans les blancs de bourrage (« B/30      ») ; vide → null. */
export function texte(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/** Un nombre de cellule — « 1 200,50 » comme 1200.5 ; illisible → null. */
export function nombre(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = texte(v);
  if (!t) return null;
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (a: number, m: number, j: number) => `${a}-${pad(m)}-${pad(j)}`;

function dateValide(a: number, m: number, j: number): boolean {
  if (a < 1990 || a > 2100 || m < 1 || m > 12 || j < 1 || j > 31) return false;
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

/**
 * UNE DATE DE CELLULE → « AAAA-MM-JJ », ou null.
 *   • numéro de série Excel (45663 = 06/01/2025) — la forme brute des cellules date ;
 *   • texte « jj/mm/aa » (DATEFACT des ventes : « 31/05/26 ») ou « jj/mm/aaaa » ;
 *   • texte ISO « 2025-01-06… » ;
 *   • `Date` — arrondie au jour le plus proche : une date lue à minuit heure d'Alger arrive en « veille 23:00 UTC ».
 * Une cellule vide ou blanche (ligne non servie) rend null — jamais une date inventée.
 */
export function lireDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const t = texte(v);
  if (!t) return null;
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const j = Number(m[1]), mo = Number(m[2]);
    const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return dateValide(a, mo, j) ? iso(a, mo, j) : null;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const a = Number(m[1]), mo = Number(m[2]), j = Number(m[3]);
    return dateValide(a, mo, j) ? iso(a, mo, j) : null;
  }
  return null;
}

/** Le mois d'une date ISO : « 2026-05-31 » → « 2026-05 ». */
export const moisDe = (dateIso: string): string => dateIso.slice(0, 7);

/**
 * CE QUE DIT UNE LIGNE DE VENTE.
 *   • livré < 0 → RETOUR (avoir) ;
 *   • commandé > 0 et livré = 0 → NON_SERVIE : l'hôpital a demandé, la DR n'a rien eu à donner (rupture) ;
 *   • 0 < livré < commandé → PARTIELLE ;
 *   • livré > 0 → SERVIE (y compris livré sans commande : dotation, régularisation) ;
 *   • rien commandé, rien livré → NULLE.
 */
export function classerLigne(qteCommandee: number, qteLivree: number): StatutLigne {
  if (qteLivree < 0) return "RETOUR";
  if (qteLivree === 0) return qteCommandee > 0 ? "NON_SERVIE" : "NULLE";
  if (qteCommandee > qteLivree) return "PARTIELLE";
  return "SERVIE";
}

/** La quantité demandée et NON servie d'une ligne — la règle de la Direction : les lignes livrées à 0. */
export function quantiteNonServie(statut: StatutLigne, qteCommandee: number): number {
  return statut === "NON_SERVIE" ? Math.max(0, qteCommandee) : 0;
}

/** Le code d'une DR, dans une écriture stable : « DRBe » → « DRBE ». */
export function codeDr(v: unknown): string | null {
  const t = texte(v);
  return t ? t.toUpperCase().replace(/\s+/g, "") : null;
}

// ─────────────────────────── Lignes ───────────────────────────

export interface LigneVenteLue {
  ligneSource: number;
  dr: string;
  famille: string | null;
  classe: string | null;
  client: string;
  poste: number | null;
  dci: string;
  uc: string | null;
  lot: string | null;
  ddp: string | null;
  qteCommandee: number;
  qteLivree: number;
  coutAchat: number | null;
  prixVente: number | null;
  /** AAAA-MM-JJ, null pour une ligne non servie (pas de facture). */
  dateFacture: string | null;
  statut: StatutLigne;
}

export interface LigneReceptionLue {
  ligneSource: number;
  gamme: string | null;
  classe: string | null;
  codeFour: number | null;
  fournisseur: string;
  numBr: string | null;
  codePro: number | null;
  designation: string;
  conditionnement: string | null;
  qte: number;
  coutUnit: number | null;
  devise: string | null;
  dateStockage: string | null;
  /** FO fournisseur · TR transfert entre annexes · RC retour client · CO correction de stock. */
  type: string;
  avoirNo: string | null;
}

const entier = (v: unknown): number => Math.round(nombre(v) ?? 0);
const entierOuNull = (v: unknown): number | null => { const n = nombre(v); return n === null ? null : Math.round(n); };

export interface LectureVentes { lignes: LigneVenteLue[]; ignorees: number }
export interface LectureReceptions { lignes: LigneReceptionLue[]; ignorees: number }

/** Les lignes de VENTES d'une DR. Une ligne sans client ni désignation (pied de tableau, ligne vide) est écartée et comptée. */
export function lireVentes(lignes: readonly unknown[][], e: Extract<Entete, { nature: "VENTES_DR" }>): LectureVentes {
  const ix = e.index;
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : null);
  const out: LigneVenteLue[] = [];
  let ignorees = 0;
  for (let i = e.ligne + 1; i < lignes.length; i++) {
    const r = lignes[i] ?? [];
    const client = texte(at(r, ix.CLIENT));
    const dci = texte(at(r, ix.DCI));
    if (!client || !dci) { if (r.some((c) => texte(c))) ignorees++; continue; }
    const qteCommandee = entier(at(r, ix.QTE_COMMANDEE));
    const qteLivree = entier(at(r, ix.QTE_LIVREE));
    out.push({
      ligneSource: i + 1,
      dr: codeDr(at(r, ix.ANNEXE)) ?? "",
      famille: texte(at(r, ix.FAMILLE)),
      classe: texte(at(r, ix.CLASSE)),
      client,
      poste: entierOuNull(at(r, ix.POSTE)),
      dci,
      uc: texte(at(r, ix.UC)),
      lot: texte(at(r, ix.LOT)),
      ddp: texte(at(r, ix.DDP)),
      qteCommandee,
      qteLivree,
      coutAchat: nombre(at(r, ix.COUT_ACHAT)),
      prixVente: nombre(at(r, ix.PRIX_VENTE)),
      dateFacture: lireDate(at(r, ix.DATEFACT)),
      statut: classerLigne(qteCommandee, qteLivree),
    });
  }
  return { lignes: out, ignorees };
}

/** Les lignes de RÉCEPTIONS de la PCH centrale. */
export function lireReceptions(lignes: readonly unknown[][], e: Extract<Entete, { nature: "RECEPTIONS" }>): LectureReceptions {
  const ix = e.index;
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : null);
  const out: LigneReceptionLue[] = [];
  let ignorees = 0;
  for (let i = e.ligne + 1; i < lignes.length; i++) {
    const r = lignes[i] ?? [];
    const fournisseur = texte(at(r, ix.NOM_FOUR));
    const designation = texte(at(r, ix.DESI_PRO));
    if (!fournisseur || !designation) { if (r.some((c) => texte(c))) ignorees++; continue; }
    out.push({
      ligneSource: i + 1,
      gamme: texte(at(r, ix.GAMME)),
      classe: texte(at(r, ix.DESI_CLASSE)),
      codeFour: entierOuNull(at(r, ix.CODE_FOUR)),
      fournisseur,
      numBr: texte(at(r, ix.NUM_BR)),
      codePro: entierOuNull(at(r, ix.CODE_PRO)),
      designation,
      conditionnement: texte(at(r, ix.CODE_COND)),
      qte: entier(at(r, ix.QTE)),
      coutUnit: nombre(at(r, ix.COUT_UNIT)),
      devise: texte(at(r, ix.CODE_MON))?.toUpperCase() ?? null,
      dateStockage: lireDate(at(r, ix.DATESTOCKAGE)),
      type: texte(at(r, ix.TYPE_RECEP))?.toUpperCase() ?? "",
      avoirNo: texte(at(r, ix.AVOIRNO)),
    });
  }
  return { lignes: out, ignorees };
}

// ─────────────────────────── Période ───────────────────────────

export interface PeriodeFichier {
  /** Les mois couverts, triés (« 2026-05 »). */
  mois: string[];
  debut: string;
  fin: string;
  /** Douze mois ou plus : un fichier ANNUEL (il remplace l'année entière de sa source). */
  annuel: boolean;
  /** Le mois auquel se rattachent les lignes SANS date (non servies) — le mois dominant du fichier. */
  moisSansDate: string;
}

/**
 * LA PÉRIODE D'UN FICHIER — lue sur les dates qu'il porte (DATEFACT, DATESTOCKAGE), jamais sur son nom.
 * Les lignes non servies n'ont pas de date : elles se rattachent au mois DOMINANT du fichier (un fichier mensuel
 * n'en a qu'un). Aucune date du tout → null : la période ne se devine pas.
 */
export function periodeDuFichier(dates: readonly (string | null)[]): PeriodeFichier | null {
  const compte = new Map<string, number>();
  for (const d of dates) if (d) compte.set(moisDe(d), (compte.get(moisDe(d)) ?? 0) + 1);
  if (compte.size === 0) return null;
  const mois = [...compte.keys()].sort();
  const moisSansDate = [...compte.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];
  return { mois, debut: mois[0], fin: mois[mois.length - 1], annuel: mois.length >= 12, moisSansDate };
}

/** « mai 2026 » — un mois lisible. */
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export function libelleMois(mois: string): string {
  const [a, m] = mois.split("-").map(Number);
  return `${MOIS_FR[(m || 1) - 1]} ${a}`;
}

export function libellePeriode(p: Pick<PeriodeFichier, "debut" | "fin" | "annuel">): string {
  if (p.debut === p.fin) return libelleMois(p.debut);
  if (p.annuel && p.debut.endsWith("-01") && p.fin.endsWith("-12") && p.debut.slice(0, 4) === p.fin.slice(0, 4)) return `année ${p.debut.slice(0, 4)}`;
  return `${libelleMois(p.debut)} → ${libelleMois(p.fin)}`;
}
