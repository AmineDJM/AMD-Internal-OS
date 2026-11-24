/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DES DEMANDES AD & PRO — ses règles d'écran, sans React ni base (testées : `liste.test.ts`).
 *
 * Recherche, pastilles de nature et d'état, filtres rangés, tri par colonne, « depuis » et échéance : tout ce
 * que l'écran calcule se lit ici, pour qu'il se teste sans navigateur. L'écran (`ad-pro-list.tsx`) ne fait que
 * dessiner. Aucun import lourd : le module part dans le navigateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { AD_PRO_KINDS, countByState, type AdProKind, type AdProRequest, type AdProState } from "@/modules/ad-pro/partage";

/**
 * CE QUE LE SERVEUR AJOUTE À UNE DEMANDE POUR LA LISTE — chez qui elle en est, depuis quand, et si c'est à la
 * personne qui regarde (la règle du circuit, la même que la carte « À vous » de la fiche).
 */
export interface AttenteDemande {
  /** « vous », « Direction Marketing », « le demandeur »… — `null` quand rien n'attend personne. */
  chezQui: string | null;
  /** L'étape où elle en est (« Prévalidation », « Correction »…) — au survol, et sous l'état au téléphone. */
  etape: string | null;
  aVous: boolean;
  /** Depuis quand la demande est à son étape (ISO) — `null` si elle est close. */
  depuis: string | null;
  /** La prochaine date qui compte (début du congrès ou de l'événement, besoin du matériel, fin du contrat). */
  echeance: string | null;
}

export type LigneAdPro = AdProRequest & AttenteDemande;

export const cleDemande = (r: Pick<AdProRequest, "kind" | "id">) => `${r.kind}:${r.id}`;

/** Une demande close n'attend plus personne : ni « chez qui », ni « depuis », ni échéance. */
export const estClose = (s: AdProState) => s === "DONE" || s === "REFUSED";

// ─── Recherche et filtres ───────────────────────────────────────────────────────────────────

export interface FiltresListe {
  /** La recherche instantanée : objet, référence, médecin ou bénéficiaire, demandeur, nature. */
  q: string;
  kind: AdProKind | "";
  /** Un état, ou « A_VOUS » : ce qui attend la personne connectée. */
  etat: AdProState | "A_VOUS" | "";
  // Les filtres de colonne d'avant, rangés dans « Filtres » — aucun ne disparaît.
  reference: string;
  title: string;
  beneficiary: string;
  requester: string;
  minAmount: string;
  dateFrom: string;
}

export const FILTRES_VIDES: FiltresListe = {
  q: "", kind: "", etat: "", reference: "", title: "", beneficiary: "", requester: "", minAmount: "", dateFrom: "",
};

/** Les filtres du panneau « Filtres » — le badge du bouton les compte. */
const CHAMPS_DU_PANNEAU = ["reference", "title", "beneficiary", "requester", "minAmount", "dateFrom"] as const;

export function nombreDeFiltresRanges(f: FiltresListe): number {
  return CHAMPS_DU_PANNEAU.filter((k) => f[k].trim() !== "").length;
}

export function filtresActifs(f: FiltresListe): boolean {
  return Object.values(f).some((v) => v !== "");
}

/** « Prise en charge » trouve « prise-en-charge », « Benali » trouve « BENALI », « evenement » trouve « Événement ». */
export function normaliser(s: string | null | undefined): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const libelleNature = (k: AdProKind) => AD_PRO_KINDS.find((x) => x.kind === k)?.label ?? k;

/** Chaque mot doit se trouver quelque part : « benali congrès » isole le congrès du Dr Benali. */
export function correspondRecherche(r: AdProRequest, q: string): boolean {
  const mots = normaliser(q).split(/\s+/).filter(Boolean);
  if (mots.length === 0) return true;
  const botte = normaliser([r.title, r.reference, r.beneficiary, r.requester, libelleNature(r.kind)].join(" "));
  return mots.every((m) => botte.includes(m));
}

const contient = (valeur: string | null, cherche: string) => normaliser(valeur).includes(normaliser(cherche));

/** Le jour (Africa/Algiers n'a pas d'heure d'été : la date ISO du jour suffit) d'une date « à partir du ». */
function avantLeJour(iso: string, jour: string): boolean {
  return iso.slice(0, 10) < jour;
}

type Sauf = "kind" | "etat" | null;

/** Tous les filtres, sauf éventuellement un — c'est ce qui donne aux pastilles des compteurs justes. */
function passe(r: LigneAdPro, f: FiltresListe, sauf: Sauf): boolean {
  if (!correspondRecherche(r, f.q)) return false;
  if (sauf !== "kind" && f.kind && r.kind !== f.kind) return false;
  if (sauf !== "etat" && f.etat) {
    if (f.etat === "A_VOUS" ? !r.aVous : r.state !== f.etat) return false;
  }
  if (f.reference && !contient(r.reference, f.reference)) return false;
  if (f.title && !contient(r.title, f.title)) return false;
  if (f.beneficiary && !contient(r.beneficiary, f.beneficiary)) return false;
  if (f.requester && !contient(r.requester, f.requester)) return false;
  if (f.minAmount.trim() !== "") {
    const min = Number(f.minAmount.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(min) && !(r.amount !== null && r.amount >= min)) return false;
  }
  if (f.dateFrom && avantLeJour(r.createdAt, f.dateFrom)) return false;
  return true;
}

export function filtrer(lignes: readonly LigneAdPro[], f: FiltresListe): LigneAdPro[] {
  return lignes.filter((r) => passe(r, f, null));
}

// ─── Pastilles et compteurs ─────────────────────────────────────────────────────────────────

interface Pastille<K extends string> {
  cle: K;
  label: string;
  n: number;
}

/**
 * LES PASTILLES DE NATURE — une par nature PRÉSENTE dans la liste, dans l'ordre du registre. Le compte suit la
 * recherche et les autres filtres (pas celui de la nature elle-même : sinon cliquer « Sponsoring » mettrait toutes
 * les autres pastilles à zéro, et l'on ne verrait plus où aller ensuite).
 */
export function pastillesNature(lignes: readonly LigneAdPro[], f: FiltresListe): Pastille<AdProKind>[] {
  const restantes = lignes.filter((r) => passe(r, f, "kind"));
  return AD_PRO_KINDS
    .filter((k) => lignes.some((r) => r.kind === k.kind))
    .map((k) => ({ cle: k.kind, label: k.label, n: restantes.filter((r) => r.kind === k.kind).length }));
}

/** L'ordre de lecture des états : ce qui attend d'abord, ce qui est clos ensuite. */
const ORDRE_ETATS: AdProState[] = ["AWAITING", "RETURNED", "DRAFT", "APPROVED", "DONE", "REFUSED"];

/** Libellés courts des pastilles d'état (le badge de la ligne garde le libellé complet de `AD_PRO_STATE`). */
const LIBELLE_PASTILLE_ETAT: Record<AdProState, string> = {
  AWAITING: "En attente",
  RETURNED: "À corriger",
  DRAFT: "Brouillons",
  APPROVED: "Validées",
  DONE: "Terminées",
  REFUSED: "Refusées",
};

/**
 * LES PASTILLES D'ÉTAT — « À vous » en tête quand quelque chose attend la personne connectée, puis chaque état
 * présent. Elles remplacent les tuiles-compteurs d'en-tête : le même chiffre, mais cliquable, et qui suit le filtre.
 */
export function pastillesEtat(lignes: readonly LigneAdPro[], f: FiltresListe): Pastille<AdProState | "A_VOUS">[] {
  const restantes = lignes.filter((r) => passe(r, f, "etat"));
  const n = countByState(restantes);
  const presents = countByState(lignes);
  const out: Pastille<AdProState | "A_VOUS">[] = [];
  if (lignes.some((r) => r.aVous)) out.push({ cle: "A_VOUS", label: "À vous", n: restantes.filter((r) => r.aVous).length });
  for (const s of ORDRE_ETATS) {
    if (presents[s] > 0) out.push({ cle: s, label: LIBELLE_PASTILLE_ETAT[s], n: n[s] });
  }
  return out;
}

// ─── Tri ────────────────────────────────────────────────────────────────────────────────────

export type ColonneTri = "nature" | "objet" | "demandeur" | "montant" | "etat" | "echeance" | "depot";
export interface Tri { col: ColonneTri; sens: "asc" | "desc" }

const rangEtat = (s: AdProState) => ORDRE_ETATS.indexOf(s);

/** Une valeur absente (montant, échéance) va TOUJOURS en bas, quel que soit le sens : « — » n'est ni petit ni grand. */
function comparerAvecVides<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number, sens: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return sens * cmp(a, b);
}

const texte = (x: string, y: string) => x.localeCompare(y, "fr", { sensitivity: "base" });

/**
 * LE TRI. Sans colonne choisie : ce qui attend la personne connectée EN TÊTE, puis l'ordre du serveur (ce qui
 * attend une décision, puis le plus récent — `sortAdPro`). Avec une colonne : cet ordre-là, et le reste stable.
 */
export function trier(lignes: readonly LigneAdPro[], tri: Tri | null): LigneAdPro[] {
  const indexe = lignes.map((r, i) => ({ r, i }));
  const s: 1 | -1 = tri?.sens === "desc" ? -1 : 1;
  indexe.sort((A, B) => {
    const a = A.r, b = B.r;
    let d = 0;
    if (!tri) d = Number(b.aVous) - Number(a.aVous);
    else if (tri.col === "nature") d = s * texte(libelleNature(a.kind), libelleNature(b.kind));
    else if (tri.col === "objet") d = s * texte(a.title, b.title);
    else if (tri.col === "demandeur") d = comparerAvecVides(a.requester, b.requester, texte, s);
    else if (tri.col === "montant") d = comparerAvecVides(a.amount, b.amount, (x, y) => x - y, s);
    else if (tri.col === "etat") d = s * (rangEtat(a.state) - rangEtat(b.state)) || Number(b.aVous) - Number(a.aVous);
    else if (tri.col === "echeance") d = comparerAvecVides(a.echeance, b.echeance, texte, s);
    else if (tri.col === "depot") d = s * a.createdAt.localeCompare(b.createdAt);
    return d || A.i - B.i;
  });
  return indexe.map((x) => x.r);
}

/** Un clic sur une colonne : croissant, puis décroissant, puis retour à l'ordre « ce qui attend d'abord ». */
export function triSuivant(actuel: Tri | null, col: ColonneTri): Tri | null {
  // Les montants, dates de dépôt et échéances se lisent d'abord du plus grand / plus récent / plus proche.
  const premier: Tri["sens"] = col === "montant" || col === "depot" ? "desc" : "asc";
  if (!actuel || actuel.col !== col) return { col, sens: premier };
  if (actuel.sens === premier) return { col, sens: premier === "asc" ? "desc" : "asc" };
  return null;
}

// ─── Le temps ───────────────────────────────────────────────────────────────────────────────

const JOUR = 86_400_000;

/** « aujourd'hui », « depuis 1 j », « depuis 3 sem. », « depuis 2 mois » — l'attente en un mot. */
export function libelleDepuis(iso: string | null, maintenant: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const jours = Math.floor((maintenant - t) / JOUR);
  if (jours < 1) return "aujourd'hui";
  if (jours < 14) return `depuis ${jours} j`;
  if (jours < 60) return `depuis ${Math.floor(jours / 7)} sem.`;
  return `depuis ${Math.floor(jours / 30)} mois`;
}

/** Une attente qui s'allonge se voit : au-delà de 7 jours, le « depuis » passe en couleur d'alerte. */
export const attenteLongue = (iso: string | null, maintenant: number) => iso !== null && maintenant - Date.parse(iso) > 7 * JOUR;

interface EcheanceLue {
  /** « dans 3 j », « demain », « aujourd'hui », « dépassée de 2 j » — à côté de la date. */
  relatif: string;
  /** Moins de 7 jours devant : à surveiller. */
  proche: boolean;
  depassee: boolean;
}

export function lireEcheance(iso: string | null, maintenant: number): EcheanceLue | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // On compte en JOURS CIVILS : un congrès qui ouvre demain matin est « demain », pas « dans 0 j ».
  const jours = Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(new Date(maintenant).toISOString().slice(0, 10))) / JOUR);
  if (jours < 0) return { relatif: `dépassée de ${-jours} j`, proche: false, depassee: true };
  if (jours === 0) return { relatif: "aujourd'hui", proche: true, depassee: false };
  if (jours === 1) return { relatif: "demain", proche: true, depassee: false };
  return { relatif: `dans ${jours} j`, proche: jours <= 7, depassee: false };
}
