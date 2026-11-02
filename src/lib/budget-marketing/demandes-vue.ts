import { plier } from "@/lib/utils";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING › DEMANDES AD & PRO — UNE LIGNE PAR DEMANDE (maquette « onglets » validée, Direction 10/2026).
 *
 * L'écran listait un POSTE par ligne : ASARI apparaissait deux fois (son sponsoring, puis l'honoraire de son symposium).
 * Ici la demande porte ses postes, chacun avec son imputation (« Événements › Symposium »), et les filtres — statut
 * (dont « pièces manquantes »), catégorie (sous-catégories COMPRISES), origine (Historique 2026 / circuit normal) et la
 * recherche — vivent dans l'adresse : le lien « Voir les demandes » de la vue d'ensemble ouvre la liste déjà filtrée.
 *
 * Module PUR, sans aucun import : lu par la page serveur, l'écran client et les tests.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un poste Ad & Pro rangé dans l'enveloppe, tel que la requête le lit (`queries/budget-marketing.ts`). */
export interface PosteVue {
  id: string;
  /** La demande qui porte le poste (`TYPE:id`). */
  cleDemande: string;
  demande: string;
  nature: string;
  href: string | null;
  lieu: string | null;
  demandeur: string | null;
  /** Date ISO : le paiement d'un poste historique, sinon la création du poste. */
  date: string | null;
  poste: string;
  categorieId: string | null;
  /** « Événements › Symposium » (la tête, puis la sous-catégorie). */
  categorie: string;
  /** Statut du poste (DRAFT, PENDING, REVISION, APPROVED, REJECTED) — « HISTORIQUE » pour un poste du lot 2026. */
  statutCle: string;
  statut: string;
  accorde: number;
  engage: number;
  regle: number;
  historique?: { ligne: number | null } | null;
}

/** Ce que le lot d'intégration dit d'une demande qu'il porte. */
export interface InfoLotDemande {
  mode: "CREEE" | "COMPLETEE";
  lignes: number[];
  attendues: number;
  manquantes: number;
  demandeurAffiche?: string | null;
}

export type CleStatutDemande = "ACCORDEE" | "ENGAGEE" | "PAYEE" | "EN_COURS";
export type CleOrigine = "HISTORIQUE" | "CIRCUIT";

export const LIBELLE_STATUT_DEMANDE: Record<CleStatutDemande, string> = {
  ACCORDEE: "Accordée", ENGAGEE: "Engagée", PAYEE: "Payée", EN_COURS: "En cours",
};

export interface DemandeVue {
  cle: string;
  libelle: string;
  nature: string;
  href: string | null;
  lieu: string | null;
  demandeur: string | null;
  date: string | null;
  postes: PosteVue[];
  accorde: number;
  engage: number;
  regle: number;
  origine: CleOrigine;
  /** Le mode du lot 2026 (badge « Historique 2026 » ou « Complétée ») — `null` hors lot. */
  mode: "CREEE" | "COMPLETEE" | null;
  /** Les lignes du fichier « Dépenses AP » (lot 2026). */
  lignes: number[];
  /** Pièces attendues / manquantes (lot 2026) — `null` quand la demande n'en attend pas ici. */
  pieces: { attendues: number; manquantes: number } | null;
  statut: CleStatutDemande;
}

/** Le statut d'une demande, lu sur ses postes : payée en entier, engagée (ou payée en partie), accordée, en cours. */
export function statutDeLaDemande(postes: readonly Pick<PosteVue, "statutCle" | "accorde" | "engage" | "regle">[]): CleStatutDemande {
  const accorde = postes.reduce((a, p) => a + p.accorde, 0);
  const engage = postes.reduce((a, p) => a + p.engage, 0);
  const regle = postes.reduce((a, p) => a + p.regle, 0);
  if (regle > 0.5 && regle >= accorde - 0.5 && engage <= 0.5) return "PAYEE";
  if (engage > 0.5 || regle > 0.5) return "ENGAGEE";
  if (postes.some((p) => p.statutCle === "APPROVED")) return "ACCORDEE";
  return "EN_COURS";
}

/**
 * LE REGROUPEMENT — une ligne par demande, ses postes dessous (dans l'ordre de lecture), ses montants additionnés, son
 * origine (un poste historique suffit à la dire « Historique 2026 ») et ce que le lot en dit (mode, lignes, pièces).
 * Tri : montant accordé décroissant, puis libellé.
 */
export function regrouperParDemande(postes: readonly PosteVue[], lot: Readonly<Record<string, InfoLotDemande>> = {}): DemandeVue[] {
  const par = new Map<string, PosteVue[]>();
  for (const p of postes) par.set(p.cleDemande, [...(par.get(p.cleDemande) ?? []), p]);
  const out: DemandeVue[] = [];
  for (const [cle, ps] of par) {
    const t = ps[0];
    const info = lot[cle] ?? null;
    const historique = ps.some((p) => p.historique);
    const lignesPostes = ps.map((p) => p.historique?.ligne).filter((x): x is number => typeof x === "number");
    const lignes = [...new Set([...(info?.lignes ?? []), ...lignesPostes])].sort((a, b) => a - b);
    const dates = ps.map((p) => p.date).filter((d): d is string => Boolean(d)).sort();
    out.push({
      cle, libelle: t.demande, nature: t.nature, href: t.href, lieu: t.lieu,
      demandeur: info?.mode === "CREEE" && info.demandeurAffiche ? info.demandeurAffiche : t.demandeur,
      date: dates[0] ?? null,
      postes: ps,
      accorde: ps.reduce((a, p) => a + p.accorde, 0),
      engage: ps.reduce((a, p) => a + p.engage, 0),
      regle: ps.reduce((a, p) => a + p.regle, 0),
      origine: historique || info ? "HISTORIQUE" : "CIRCUIT",
      mode: info?.mode ?? null,
      lignes,
      pieces: info ? { attendues: info.attendues, manquantes: info.manquantes } : null,
      statut: statutDeLaDemande(ps),
    });
  }
  return out.sort((a, b) => b.accorde - a.accorde || a.libelle.localeCompare(b.libelle, "fr"));
}

// ───────────────────────────── Les filtres (dans l'adresse) ─────────────────────────────

export type CleFiltreStatut = "TOUT" | CleStatutDemande | "MANQUANTES";
export type CleFiltreOrigine = "TOUT" | CleOrigine;

export interface FiltresDemandes {
  statut: CleFiltreStatut;
  /** Une catégorie (ses sous-catégories comprises) — `null` = toutes. */
  cat: string | null;
  origine: CleFiltreOrigine;
  q: string;
}

export const FILTRES_DEMANDES_DEFAUT: FiltresDemandes = { statut: "TOUT", cat: null, origine: "TOUT", q: "" };

const STATUTS_FILTRE: CleFiltreStatut[] = ["TOUT", "ACCORDEE", "ENGAGEE", "PAYEE", "EN_COURS", "MANQUANTES"];
const ORIGINES_FILTRE: CleFiltreOrigine[] = ["TOUT", "HISTORIQUE", "CIRCUIT"];
const ALIAS_STATUT: Record<string, CleFiltreStatut> = {
  tout: "TOUT", accordee: "ACCORDEE", engagee: "ENGAGEE", payee: "PAYEE", "en-cours": "EN_COURS", manquantes: "MANQUANTES",
};
const ALIAS_ORIGINE: Record<string, CleFiltreOrigine> = { tout: "TOUT", historique: "HISTORIQUE", circuit: "CIRCUIT" };
const aliasDe = <T extends string>(table: Record<string, T>, v: T): string => Object.entries(table).find(([, x]) => x === v)?.[0] ?? "";

/** Les filtres lus d'une adresse (`statut`, `cat`, `origine`, `q`) ; une valeur inconnue retombe sur « toutes ». */
export function filtresDemandesDepuis(sp: { statut?: string | null; cat?: string | null; origine?: string | null; q?: string | null }, categories?: readonly { id: string }[]): FiltresDemandes {
  const brut = (s: string | null | undefined) => (s ?? "").trim();
  const st = brut(sp.statut);
  const statut = ALIAS_STATUT[st.toLowerCase()] ?? (STATUTS_FILTRE.includes(st as CleFiltreStatut) ? (st as CleFiltreStatut) : "TOUT");
  const or = brut(sp.origine);
  const origine = ALIAS_ORIGINE[or.toLowerCase()] ?? (ORIGINES_FILTRE.includes(or as CleFiltreOrigine) ? (or as CleFiltreOrigine) : "TOUT");
  const c = brut(sp.cat);
  const cat = c && (!categories || categories.some((x) => x.id === c)) ? c : null;
  return { statut, cat, origine, q: brut(sp.q).slice(0, 120) };
}

/** L'adresse des filtres (sans les valeurs par défaut) — ce que la barre d'adresse et les liens portent. */
export function requeteDemandes(f: FiltresDemandes, extra: Record<string, string | null | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  if (f.statut !== "TOUT") q.set("statut", aliasDe(ALIAS_STATUT, f.statut));
  if (f.cat) q.set("cat", f.cat);
  if (f.origine !== "TOUT") q.set("origine", aliasDe(ALIAS_ORIGINE, f.origine));
  if (f.q) q.set("q", f.q);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Le texte où cherche la recherche : libellé, nature, lieu, demandeur, postes et leur imputation, lignes « L12 ». */
function texteDe(d: DemandeVue): string {
  return plier([d.libelle, d.nature, d.lieu ?? "", d.demandeur ?? "", ...d.postes.map((p) => `${p.poste} ${p.categorie}`), ...d.lignes.map((l) => `l${l}`)].join(" "));
}

/**
 * Une demande passe-t-elle les filtres ? `sauf` ignore UN filtre (le compte d'une puce se lit avec les autres filtres
 * appliqués, pas le sien). `idsCat` : la catégorie filtrée et ses descendantes.
 */
export function passeFiltres(d: DemandeVue, f: FiltresDemandes, idsCat: ReadonlySet<string> | null, sauf?: "statut" | "origine" | "cat"): boolean {
  if (sauf !== "statut" && f.statut !== "TOUT") {
    if (f.statut === "MANQUANTES" ? !(d.pieces && d.pieces.manquantes > 0) : d.statut !== f.statut) return false;
  }
  if (sauf !== "origine" && f.origine !== "TOUT" && d.origine !== f.origine) return false;
  if (sauf !== "cat" && f.cat && idsCat && !d.postes.some((p) => p.categorieId !== null && idsCat.has(p.categorieId))) return false;
  if (f.q) {
    const txt = texteDe(d);
    if (!plier(f.q).split(/\s+/).filter(Boolean).every((w) => txt.includes(w))) return false;
  }
  return true;
}

/** Le nombre de demandes par puce (statut ou origine), les AUTRES filtres appliqués. */
export function comptesDesPuces(demandes: readonly DemandeVue[], f: FiltresDemandes, idsCat: ReadonlySet<string> | null): { statut: Record<CleFiltreStatut, number>; origine: Record<CleFiltreOrigine, number> } {
  const statut = Object.fromEntries(STATUTS_FILTRE.map((k) => [k, 0])) as Record<CleFiltreStatut, number>;
  const origine = Object.fromEntries(ORIGINES_FILTRE.map((k) => [k, 0])) as Record<CleFiltreOrigine, number>;
  for (const d of demandes) {
    if (passeFiltres(d, f, idsCat, "statut")) {
      statut.TOUT += 1;
      statut[d.statut] += 1;
      if (d.pieces && d.pieces.manquantes > 0) statut.MANQUANTES += 1;
    }
    if (passeFiltres(d, f, idsCat, "origine")) {
      origine.TOUT += 1;
      origine[d.origine] += 1;
    }
  }
  return { statut, origine };
}

/** Ce qu'une demande pèse DANS la catégorie filtrée (ses postes qui y sont imputés), ou en entier sans filtre. */
export function montantsDansLaCategorie(d: DemandeVue, idsCat: ReadonlySet<string> | null): { accorde: number; engage: number; regle: number } {
  const ps = idsCat ? d.postes.filter((p) => p.categorieId !== null && idsCat.has(p.categorieId)) : d.postes;
  return { accorde: ps.reduce((a, p) => a + p.accorde, 0), engage: ps.reduce((a, p) => a + p.engage, 0), regle: ps.reduce((a, p) => a + p.regle, 0) };
}

/** Les tuiles en tête : demandes affichées, accordé / engagé / réglé (dans la catégorie filtrée), pièces jointes / attendues. */
export function tuilesDemandes(visibles: readonly DemandeVue[], idsCat: ReadonlySet<string> | null): { demandes: number; accorde: number; engage: number; regle: number; piecesAttendues: number; piecesManquantes: number } {
  let accorde = 0, engage = 0, regle = 0, piecesAttendues = 0, piecesManquantes = 0;
  for (const d of visibles) {
    const m = montantsDansLaCategorie(d, idsCat);
    accorde += m.accorde; engage += m.engage; regle += m.regle;
    if (d.pieces) { piecesAttendues += d.pieces.attendues; piecesManquantes += d.pieces.manquantes; }
  }
  return { demandes: visibles.length, accorde, engage, regle, piecesAttendues, piecesManquantes };
}
