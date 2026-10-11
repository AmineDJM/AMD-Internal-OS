/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LA VUE D'ENSEMBLE EN CALCULS PURS (maquette validée par la Direction, 10/2026).
 *
 * Un seul chiffre en tête (le DISPONIBLE = enveloppe − payé − engagé) et son rythme ; ce qui demande une décision
 * (« À traiter ») ; six graphiques et un tableau qui lisent les MÊMES faits sous les MÊMES filtres (période,
 * catégorie, comparaison à N-1) — l'écran, l'Excel, le PDF, le CSV et les diapositives ne peuvent pas diverger.
 *
 * Les faits arrivent déjà lus (`queries/budget-marketing-rapport.ts`) ; ici tout est arithmétique, testée.
 * Module PUR, sans aucun import : il est lu par l'écran client ET par les exports serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ───────────────────────────── Les catégories, sous-catégories comprises ─────────────────────────────

export interface CategorieBrute {
  id: string;
  name: string;
  parentId: string | null;
  allocated: number;
  consumed: number;
  committed: number;
}

/** Une catégorie de tête, ses sous-catégories repliées dedans. */
export interface CategorieVue {
  id: string;
  nom: string;
  alloue: number;
  paye: number;
  engage: number;
}

/**
 * Replie les sous-catégories dans leur catégorie de tête : une dépense imputée à « Table ronde » (sous « Événements »)
 * consomme Événements. L'alloué reste celui de la tête (une sous-catégorie répartit DANS sa tête, elle n'ajoute rien).
 */
export function roulerCategories(cats: readonly CategorieBrute[]): { tetes: CategorieVue[]; versTete: Record<string, string> } {
  const parId = new Map(cats.map((c) => [c.id, c]));
  const versTete: Record<string, string> = {};
  for (const c of cats) {
    let t = c;
    const vus = new Set<string>();
    while (t.parentId && parId.has(t.parentId) && !vus.has(t.id)) { vus.add(t.id); t = parId.get(t.parentId)!; }
    versTete[c.id] = t.id;
  }
  const tetes = new Map<string, CategorieVue>();
  for (const c of cats) if (versTete[c.id] === c.id) tetes.set(c.id, { id: c.id, nom: c.name, alloue: c.allocated, paye: 0, engage: 0 });
  for (const c of cats) {
    const t = tetes.get(versTete[c.id]);
    if (!t) continue;
    t.paye += c.consumed;
    t.engage += c.committed;
  }
  return { tetes: [...tetes.values()], versTete };
}

// ───────────────────────────── Le disponible et le rythme ─────────────────────────────

export const dinar = (n: number): number => Math.round(Number.isFinite(n) ? n : 0);

export function disponible(total: number, paye: number, engage: number): number {
  return total - paye - engage;
}

export const pourcent = (part: number, base: number): number => (base > 0 ? (part / base) * 100 : 0);

/** La part de la période déjà écoulée à `aujourdhui`, en % (0 avant l'ouverture, 100 après la clôture). */
export function pctPeriodeEcoulee(debut: Date, fin: Date, aujourdhui: Date): number {
  const d = debut.getTime(), f = fin.getTime(), t = aujourdhui.getTime();
  if (!(f > d)) return 100;
  return Math.min(100, Math.max(0, ((t - d) / (f - d)) * 100));
}

export type CleRythme = "AU_RYTHME" | "EN_AVANCE" | "EN_RETARD";

/** Marge (en points) en deçà de laquelle on reste « au rythme de l'année ». */
export const TOLERANCE_RYTHME = 5;

/**
 * Le RYTHME : la part utilisée (payé + engagé) comparée à la part de l'année écoulée. Plus vite que l'année = en avance
 * (l'enveloppe s'épuisera avant la fin) ; plus lentement = en retard (de l'argent dort).
 */
export function rythme(utilisePct: number, ecoulePct: number): { cle: CleRythme; libelle: string } {
  if (utilisePct > ecoulePct + TOLERANCE_RYTHME) return { cle: "EN_AVANCE", libelle: "en avance sur l'année" };
  if (utilisePct < ecoulePct - TOLERANCE_RYTHME) return { cle: "EN_RETARD", libelle: "en retard sur l'année" };
  return { cle: "AU_RYTHME", libelle: "au rythme de l'année" };
}

// ───────────────────────────── À traiter ─────────────────────────────

export type GesteAlerte = "REALLOUER" | "IMPUTER" | "AJUSTER";

export interface Alerte {
  cle: string;
  niveau: "danger" | "warning";
  titre: string;
  detail: string;
  geste: GesteAlerte;
  /** La catégorie concernée (dépassement). */
  categorieId?: string;
}

const fr = (n: number) => dinar(n).toLocaleString("fr-FR").replace(/[  ]/g, " ");

/**
 * Ce qui demande une décision, du plus grave au moins grave : une catégorie au-delà de son allocation (payé + engagé
 * > alloué) se RÉALLOUE ; des dépenses sans catégorie s'IMPUTENT ; des allocations qui dépassent l'enveloppe
 * s'AJUSTENT dans les Réglages.
 */
export function alertesBudget(p: {
  categories: readonly CategorieVue[];
  sansCategorie: { total: number; count: number };
  total: number;
}): Alerte[] {
  const out: Alerte[] = [];
  const depassees = p.categories
    .filter((c) => c.paye + c.engage > c.alloue + 0.5)
    .sort((a, b) => (b.paye + b.engage - b.alloue) - (a.paye + a.engage - a.alloue));
  for (const c of depassees) {
    const utilise = c.paye + c.engage;
    const pct = c.alloue > 0 ? `${Math.round(pourcent(utilise, c.alloue))} % de son allocation` : "sans allocation";
    out.push({
      cle: `depassement-${c.id}`, niveau: "danger", geste: "REALLOUER", categorieId: c.id,
      titre: `${c.nom} : ${pct}`,
      detail: `${fr(c.paye)} payés et ${fr(c.engage)} engagés pour ${fr(c.alloue)} alloués · dépassement de ${fr(utilise - c.alloue)}`,
    });
  }
  if (p.sansCategorie.total > 0.5) {
    out.push({
      cle: "sans-categorie", niveau: "warning", geste: "IMPUTER",
      titre: `${fr(p.sansCategorie.total)} DZD de dépenses sans catégorie`,
      detail: `${p.sansCategorie.count} dépense${p.sansCategorie.count > 1 ? "s" : ""} à imputer`,
    });
  }
  const reparti = p.categories.reduce((a, c) => a + c.alloue, 0);
  if (reparti > p.total + 0.5) {
    out.push({
      cle: "repartition", niveau: "warning", geste: "AJUSTER",
      titre: `Les catégories dépassent l'enveloppe de ${fr(reparti - p.total)} DZD`,
      detail: `${fr(reparti)} répartis pour ${fr(p.total)}`,
    });
  }
  return out;
}

// ───────────────────────────── Réallouer ─────────────────────────────

export const MOTIF_MIN = 5;

/**
 * RÉALLOUER — déplacer un montant d'une catégorie à une autre de la MÊME enveloppe. L'enveloppe ne bouge pas : ce que
 * l'une perd, l'autre le gagne. Le motif est obligatoire (il reste dans l'historique). Une catégorie ne peut pas
 * céder plus que son allocation.
 */
export function refusReallocation(p: {
  sourceId: string | null | undefined;
  cibleId: string | null | undefined;
  montant: number | null | undefined;
  motif: string | null | undefined;
  source: { envelopeId: string; parentId: string | null; alloue: number } | null;
  cible: { envelopeId: string; parentId: string | null } | null;
}): string | null {
  if (!p.sourceId || !p.cibleId) return "Choisissez la catégorie qui cède et celle qui reçoit.";
  if (p.sourceId === p.cibleId) return "La catégorie qui cède et celle qui reçoit doivent être différentes.";
  if (!p.source || !p.cible) return "Catégorie introuvable.";
  if (p.source.envelopeId !== p.cible.envelopeId) return "On ne réalloue qu'entre catégories de la même enveloppe.";
  if (p.source.parentId !== null || p.cible.parentId !== null) return "On réalloue entre catégories de tête (une sous-catégorie répartit déjà sa catégorie).";
  if (p.montant == null || !Number.isFinite(p.montant) || p.montant <= 0) return "Indiquez un montant positif.";
  if (p.montant > p.source.alloue + 0.005) return `La catégorie qui cède n'a que ${fr(p.source.alloue)} DZD alloués.`;
  if (!p.motif || p.motif.trim().length < MOTIF_MIN) return "Le motif est obligatoire : il reste dans l'historique du budget.";
  return null;
}

// ───────────────────────────── Les faits et les filtres ─────────────────────────────

/** Un montant PAYÉ, rangé : catégorie de tête (`null` = sans catégorie), mois, nature, demande d'origine. */
export interface Fait {
  cat: string | null;
  mois: string;
  nature: string;
  demande: string | null;
  montant: number;
}

/** Un montant ENGAGÉ (promis, pas payé) : un stock à date, sans mois. */
export interface Engagement {
  cat: string | null;
  demande: string | null;
  montant: number;
}

export interface DemandeRef {
  cle: string;
  libelle: string;
  href: string | null;
  /** « Sponsoring », « Congrès international »… */
  type: string;
}

export interface Filtres {
  /** Premier mois inclus (« 2026-01 »). */
  debut: string;
  /** Dernier mois inclus. */
  fin: string;
  /** Catégorie de tête, `null` = toutes. */
  cat: string | null;
}

export const CLE_SANS = "__sans__";
const cleCat = (c: string | null) => c ?? CLE_SANS;

export function faitsFiltres<T extends Fait>(faits: readonly T[], f: Filtres): T[] {
  return faits.filter((x) => x.mois >= f.debut && x.mois <= f.fin && (f.cat === null || x.cat === f.cat));
}

export function engagementsFiltres<T extends Engagement>(e: readonly T[], f: Pick<Filtres, "cat">): T[] {
  return e.filter((x) => f.cat === null || x.cat === f.cat);
}

/** Payé par catégorie de tête (clé `CLE_SANS` pour « Sans catégorie »). */
export function payeParCategorie(faits: readonly Fait[], f: Filtres): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of faitsFiltres(faits, f)) out[cleCat(x.cat)] = (out[cleCat(x.cat)] ?? 0) + x.montant;
  return out;
}

export function engageParCategorie(e: readonly Engagement[], f: Pick<Filtres, "cat">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of engagementsFiltres(e, f)) out[cleCat(x.cat)] = (out[cleCat(x.cat)] ?? 0) + x.montant;
  return out;
}

/** Payé par nature, du plus gros au plus petit — « Non renseignée » toujours en dernier. */
export function parNature(faits: readonly Fait[], f: Filtres, nonRenseignee = "Non renseignée"): { nature: string; montant: number }[] {
  const m = new Map<string, number>();
  for (const x of faitsFiltres(faits, f)) m.set(x.nature, (m.get(x.nature) ?? 0) + x.montant);
  return [...m].map(([nature, montant]) => ({ nature, montant }))
    .filter((x) => x.montant > 0.5)
    .sort((a, b) => (a.nature === nonRenseignee ? 1 : b.nature === nonRenseignee ? -1 : b.montant - a.montant));
}

const MOIS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export const libelleMois = (cle: string): string => MOIS_FR[Number(cle.slice(5, 7)) - 1] ?? cle;

/** Les mois « AAAA-MM » de `debut` à `fin` inclus (60 au plus). */
export function moisEntre(debut: string, fin: string): string[] {
  const out: string[] = [];
  let a = Number(debut.slice(0, 4)), m = Number(debut.slice(5, 7));
  if (!Number.isFinite(a) || !Number.isFinite(m)) return out;
  while (out.length < 60) {
    const cle = `${a}-${String(m).padStart(2, "0")}`;
    if (cle > fin) break;
    out.push(cle);
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return out;
}

export interface PointMois {
  mois: string;
  libelle: string;
  /** Payé du mois, par catégorie de tête (`CLE_SANS` pour sans catégorie). */
  parCat: Record<string, number>;
  total: number;
  /** Cumul depuis l'OUVERTURE de l'enveloppe (pas depuis le début du filtre) : il se compare au rythme. */
  cumul: number;
  /** Rythme régulier : la base répartie également sur les mois de l'enveloppe. */
  rythme: number;
  /** Cumul de l'année précédente au même mois, quand on compare. */
  cumulN1?: number;
}

/**
 * Le payé MOIS PAR MOIS (barres empilées par catégorie), son cumul et le rythme régulier. Le cumul et le rythme
 * partent de l'ouverture de l'enveloppe ; seuls les mois du filtre sont rendus.
 */
export function serieMensuelle(p: {
  faits: readonly Fait[];
  filtres: Filtres;
  /** Tous les mois de l'enveloppe. */
  moisEnveloppe: readonly string[];
  /** La base du rythme : l'enveloppe, ou l'alloué de la catégorie filtrée. */
  base: number;
  /** Les faits N-1, déjà ramenés sur les mois de l'enveloppe (`ComparaisonN1.faits`). */
  faitsN1?: readonly Fait[] | null;
}): PointMois[] {
  const parMois = new Map<string, Record<string, number>>();
  for (const x of p.faits) {
    if (p.filtres.cat !== null && x.cat !== p.filtres.cat) continue;
    const r = parMois.get(x.mois) ?? {};
    r[cleCat(x.cat)] = (r[cleCat(x.cat)] ?? 0) + x.montant;
    parMois.set(x.mois, r);
  }
  const n1 = p.faitsN1 ? new Map<string, number>() : null;
  if (n1 && p.faitsN1) {
    for (const x of p.faitsN1) {
      if (p.filtres.cat !== null && x.cat !== p.filtres.cat) continue;
      n1.set(x.mois, (n1.get(x.mois) ?? 0) + x.montant);
    }
  }
  const n = p.moisEnveloppe.length || 1;
  let cumul = 0, cumulN1 = 0;
  const out: PointMois[] = [];
  p.moisEnveloppe.forEach((mois, i) => {
    const parCat = parMois.get(mois) ?? {};
    const total = Object.values(parCat).reduce((a, v) => a + v, 0);
    cumul += total;
    if (n1) cumulN1 += n1.get(mois) ?? 0;
    if (mois < p.filtres.debut || mois > p.filtres.fin) return;
    out.push({
      mois, libelle: libelleMois(mois), parCat, total, cumul,
      rythme: (p.base * (i + 1)) / n,
      ...(n1 ? { cumulN1 } : {}),
    });
  });
  return out;
}

export interface LigneDemande {
  cle: string;
  libelle: string;
  href: string | null;
  type: string;
  paye: number;
  engage: number;
  total: number;
}

/** Les demandes qui pèsent le plus (payé sur la période + engagé à date). */
export function topDemandes(p: {
  faits: readonly Fait[];
  engagements: readonly Engagement[];
  demandes: Record<string, DemandeRef>;
  filtres: Filtres;
  n?: number;
}): LigneDemande[] {
  return toutesLesDemandes(p).slice(0, p.n ?? 8);
}

/** Toutes les demandes de la sélection, triées par poids. */
export function toutesLesDemandes(p: {
  faits: readonly Fait[];
  engagements: readonly Engagement[];
  demandes: Record<string, DemandeRef>;
  filtres: Filtres;
}): LigneDemande[] {
  const m = new Map<string, { paye: number; engage: number }>();
  for (const x of faitsFiltres(p.faits, p.filtres)) {
    if (!x.demande) continue;
    const r = m.get(x.demande) ?? { paye: 0, engage: 0 };
    r.paye += x.montant;
    m.set(x.demande, r);
  }
  for (const x of engagementsFiltres(p.engagements, p.filtres)) {
    if (!x.demande) continue;
    const r = m.get(x.demande) ?? { paye: 0, engage: 0 };
    r.engage += x.montant;
    m.set(x.demande, r);
  }
  return [...m].map(([cle, v]) => {
    const d = p.demandes[cle];
    return { cle, libelle: d?.libelle ?? cle, href: d?.href ?? null, type: d?.type ?? "", paye: v.paye, engage: v.engage, total: v.paye + v.engage };
  }).filter((x) => x.total > 0.5).sort((a, b) => b.total - a.total);
}

/** Les demandes qui consomment UNE catégorie (payé sur toute la période + engagé). */
export function demandesDeLaCategorie(p: {
  faits: readonly Fait[];
  engagements: readonly Engagement[];
  demandes: Record<string, DemandeRef>;
  cat: string;
  debut: string;
  fin: string;
}): LigneDemande[] {
  return toutesLesDemandes({ ...p, filtres: { debut: p.debut, fin: p.fin, cat: p.cat } });
}

// ───────────────────────────── Les périodes proposées ─────────────────────────────

export interface Periode { cle: string; libelle: string; debut: string; fin: string }

/** « Année », les trimestres puis les mois de l'enveloppe (une période qui n'a aucun mois dans l'enveloppe n'est pas proposée). */
export function periodesProposees(moisEnveloppe: readonly string[]): Periode[] {
  if (moisEnveloppe.length === 0) return [];
  const debut = moisEnveloppe[0], fin = moisEnveloppe[moisEnveloppe.length - 1];
  const memeAnnee = debut.slice(0, 4) === fin.slice(0, 4);
  const out: Periode[] = [{ cle: "annee", libelle: memeAnnee ? "Année" : "Toute la période", debut, fin }];
  const trimestres = new Map<string, string[]>();
  for (const m of moisEnveloppe) {
    const t = `${m.slice(0, 4)}-T${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;
    trimestres.set(t, [...(trimestres.get(t) ?? []), m]);
  }
  for (const [t, ms] of trimestres) {
    const num = t.slice(-1);
    out.push({ cle: t, libelle: `${num === "1" ? "1er" : `${num}e`} trimestre${memeAnnee ? "" : ` ${t.slice(0, 4)}`}`, debut: ms[0], fin: ms[ms.length - 1] });
  }
  for (const m of moisEnveloppe) out.push({ cle: m, libelle: `${libelleMois(m)}${memeAnnee ? "" : ` ${m.slice(0, 4)}`}`, debut: m, fin: m });
  return out;
}

// ───────────────────────────── N-1 ─────────────────────────────

/** Un nom de catégorie comparable d'une année sur l'autre (casse, accents, espaces). */
export function nomComparable(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * L'ANNÉE PRÉCÉDENTE, ramenée sur l'enveloppe en cours : ses faits sont décalés d'un an (mars N-1 → mars N) et rangés
 * dans la catégorie de MÊME NOM (`null` quand aucune ne correspond) — les mêmes filtres s'y appliquent.
 */
export interface ComparaisonN1 {
  annee: number;
  enveloppe: string;
  total: number;
  /** Alloué N-1 par catégorie de tête EN COURS (rapprochée par le nom). */
  alloueParCat: Record<string, number>;
  faits: Fait[];
}

/** Décale une clé de mois d'un an vers l'avant (« 2025-03 » → « 2026-03 »). */
export const moisSuivantAnnee = (mois: string): string => `${Number(mois.slice(0, 4)) + 1}${mois.slice(4)}`;

// ───────────────────────────── La vue filtrée — une lecture pour l'écran et les exports ─────────────────────────────

/** Ce que la vue d'ensemble lit (sérialisable : il passe du serveur à l'écran). */
export interface DonneesMarketing {
  enveloppe: { id: string; nom: string; total: number; debut: string; fin: string };
  categories: CategorieVue[];
  sansCategorie: { total: number; count: number };
  faits: Fait[];
  engagements: Engagement[];
  demandes: Record<string, DemandeRef>;
  moisEnveloppe: string[];
  n1: ComparaisonN1 | null;
}

export interface LigneCategorie {
  id: string;
  nom: string;
  alloue: number;
  /** Payé sur TOUTE l'enveloppe (l'état du budget). */
  paye: number;
  engage: number;
  reste: number;
  /** (payé + engagé) / alloué, en %. */
  pct: number;
}

/**
 * LE TABLEAU « PAR CATÉGORIE » — l'état du budget sur toute l'enveloppe (les filtres de période ne s'y appliquent pas :
 * un reste se lit sur l'année). Trié par alloué décroissant ; les catégories sans allocation ni dépense sont omises.
 */
export function lignesParCategorie(d: Pick<DonneesMarketing, "categories" | "faits" | "engagements" | "moisEnveloppe">): LigneCategorie[] {
  const debut = d.moisEnveloppe[0] ?? "0000-00", fin = d.moisEnveloppe[d.moisEnveloppe.length - 1] ?? "9999-99";
  const paye = payeParCategorie(d.faits, { debut, fin, cat: null });
  const engage = engageParCategorie(d.engagements, { cat: null });
  return d.categories
    .map((c) => {
      const p = paye[c.id] ?? 0, e = engage[c.id] ?? 0;
      return { id: c.id, nom: c.nom, alloue: c.alloue, paye: p, engage: e, reste: c.alloue - p - e, pct: pourcent(p + e, c.alloue) };
    })
    .filter((l) => l.alloue > 0 || l.paye > 0 || l.engage > 0)
    .sort((a, b) => b.alloue - a.alloue);
}

export interface Part { id: string; nom: string; valeur: number }

export interface VueFiltree {
  filtres: Filtres;
  /** Camembert 1 — l'enveloppe répartie (alloué). */
  repartition: Part[];
  /** Camembert 2 — payé sur la période par catégorie, « Sans catégorie » compris (`CLE_SANS`). */
  payeParCat: Part[];
  /** Camembert 3 — payé sur la période par nature. */
  natures: { nature: string; montant: number }[];
  /** Barres — alloué, payé (période), engagé, payé N-1 (même période un an plus tôt) par catégorie. */
  barres: { id: string; nom: string; alloue: number; paye: number; engage: number; payeN1: number | null }[];
  /** Payé par mois, cumul et rythme. */
  mois: PointMois[];
  /** Les 8 demandes qui pèsent le plus. */
  top: LigneDemande[];
  /** Toutes les demandes de la sélection (exports). */
  demandes: LigneDemande[];
  totaux: { paye: number; engage: number; alloue: number; payeN1: number | null };
}

export const LIBELLE_SANS = "Sans catégorie";

/** Tout ce que montrent les six graphiques (et ce qu'exportent les fichiers), sous les MÊMES filtres. */
export function vueFiltree(d: DonneesMarketing, f: Filtres, comparer: boolean): VueFiltree {
  const nom = new Map(d.categories.map((c) => [c.id, c.nom]));
  const cats = f.cat === null ? d.categories : d.categories.filter((c) => c.id === f.cat);
  const paye = payeParCategorie(d.faits, f);
  const engage = engageParCategorie(d.engagements, f);
  const n1 = comparer && d.n1 ? d.n1 : null;
  // N-1 sur la MÊME période (ses faits sont déjà décalés d'un an).
  const payeN1 = n1 ? payeParCategorie(n1.faits, f) : null;
  const base = f.cat === null ? d.enveloppe.total : d.categories.find((c) => c.id === f.cat)?.alloue ?? 0;
  const demandes = toutesLesDemandes({ faits: d.faits, engagements: d.engagements, demandes: d.demandes, filtres: f });
  const barres = [...cats].sort((a, b) => b.alloue - a.alloue)
    .map((c) => ({ id: c.id, nom: c.nom, alloue: c.alloue, paye: paye[c.id] ?? 0, engage: engage[c.id] ?? 0, payeN1: payeN1 ? payeN1[c.id] ?? 0 : null }))
    .filter((b) => b.alloue > 0 || b.paye > 0 || b.engage > 0 || (b.payeN1 ?? 0) > 0);
  const payeParCat: Part[] = Object.entries(paye)
    .map(([id, valeur]) => ({ id, nom: id === CLE_SANS ? LIBELLE_SANS : nom.get(id) ?? "—", valeur }))
    .filter((p) => p.valeur > 0.5)
    .sort((a, b) => (a.id === CLE_SANS ? 1 : b.id === CLE_SANS ? -1 : b.valeur - a.valeur));
  return {
    filtres: f,
    repartition: d.categories.filter((c) => c.alloue > 0).sort((a, b) => b.alloue - a.alloue).map((c) => ({ id: c.id, nom: c.nom, valeur: c.alloue })),
    payeParCat,
    natures: parNature(d.faits, f),
    barres,
    mois: serieMensuelle({ faits: d.faits, filtres: f, moisEnveloppe: d.moisEnveloppe, base, faitsN1: n1?.faits ?? null }),
    top: demandes.slice(0, 8),
    demandes,
    totaux: {
      paye: Object.values(paye).reduce((a, v) => a + v, 0),
      engage: Object.values(engage).reduce((a, v) => a + v, 0),
      alloue: cats.reduce((a, c) => a + c.alloue, 0),
      payeN1: payeN1 ? Object.values(payeN1).reduce((a, v) => a + v, 0) : null,
    },
  };
}

/** Les filtres lus d'une adresse (`debut`, `fin`, `cat`) et bornés à l'enveloppe. */
export function filtresDepuis(moisEnveloppe: readonly string[], q: { debut?: string | null; fin?: string | null; cat?: string | null }, categories: readonly { id: string }[]): Filtres {
  const premier = moisEnveloppe[0] ?? "0000-00", dernier = moisEnveloppe[moisEnveloppe.length - 1] ?? "9999-99";
  const mois = (s: string | null | undefined, defaut: string) => (s && /^\d{4}-\d{2}$/.test(s) ? s : defaut);
  let debut = mois(q.debut, premier), fin = mois(q.fin, dernier);
  if (debut < premier) debut = premier;
  if (fin > dernier) fin = dernier;
  if (fin < debut) { debut = premier; fin = dernier; }
  const cat = q.cat && categories.some((c) => c.id === q.cat) ? q.cat : null;
  return { debut, fin, cat };
}

/** « Année 2026 », « 3e trimestre 2026 », « mars 2026 », ou « janv. → mai 2026 ». */
export function libellePeriode(f: Filtres, moisEnveloppe: readonly string[]): string {
  const p = periodesProposees(moisEnveloppe).find((x) => x.debut === f.debut && x.fin === f.fin);
  const annee = f.fin.slice(0, 4);
  if (p) return p.cle === "annee" ? (f.debut.slice(0, 4) === annee ? `Année ${annee}` : p.libelle) : `${p.libelle}${p.libelle.includes(annee) ? "" : ` ${annee}`}`;
  return `${libelleMois(f.debut)} ${f.debut.slice(0, 4)} → ${libelleMois(f.fin)} ${annee}`;
}
