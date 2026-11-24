/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DES AVANTAGES AUX PROFESSIONNELS DE SANTÉ (Super Admin seul, 24/11/2026) — les règles, pures.
 *
 * Une ligne par professionnel de l'annuaire qui additionne, par année et par société, tout ce que le groupe lui a accordé :
 * prises en charge (billets, hôtels, inscriptions, autres postes), sponsoring, événements, matériel promotionnel remis,
 * autres avantages Ad & Pro. Deux montants par avantage, jamais mélangés :
 *   • PAYÉ : acheté (ligne de BC achetée) ou réglé (ordre de dépense payé) — l'argent réellement sorti ;
 *   • ENGAGÉ : ce qui est accordé (validé, dans un BC, devis accepté), payé compris. « Engagé non payé » = engagé − payé.
 * Les parts et la concentration se lisent sur le PAYÉ.
 *
 * Le rattachement se fait par l'IDENTIFIANT d'annuaire (deux homonymes restent deux lignes) ; ce qui ne porte qu'un nom libre
 * tombe dans la ligne « non rattachés », avec son nom — jamais perdu. Un avantage dont le montant n'est pas attribuable à
 * une personne (une demande qui nomme plusieurs professionnels sans dire la part de chacun) compte dans le nombre, pas
 * dans les sommes.
 *
 * Module PUR (aucune base, aucun Node) : lu par la requête serveur comme par le tableau du navigateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NATURES_AVANTAGE = [
  "PEC_BILLET", "PEC_HOTEL", "PEC_INSCRIPTION", "PEC_AUTRE", "SPONSORING", "EVENEMENT", "MATERIEL_PROMO", "AUTRE_AD_PRO",
] as const;
export type NatureAvantage = (typeof NATURES_AVANTAGE)[number];

export const LIBELLE_NATURE_AVANTAGE: Record<NatureAvantage, string> = {
  PEC_BILLET: "Prise en charge — billet",
  PEC_HOTEL: "Prise en charge — hôtel",
  PEC_INSCRIPTION: "Prise en charge — inscription",
  PEC_AUTRE: "Prise en charge — autre poste",
  SPONSORING: "Sponsoring",
  EVENEMENT: "Événement",
  MATERIEL_PROMO: "Matériel promotionnel",
  AUTRE_AD_PRO: "Autre avantage Ad & Pro",
};

export function estNatureAvantage(v: unknown): v is NatureAvantage {
  return typeof v === "string" && (NATURES_AVANTAGE as readonly string[]).includes(v);
}

/** Un avantage accordé — une ligne de la chronologie d'un professionnel. Les dates sont en ISO (sérialisables). */
export interface Avantage {
  /** Unique et stable : `pec:<case>`, `lien:<lien>`, `spo:<demande>`, `promo:<mouvement>`. */
  id: string;
  /** La fiche d'annuaire (après fusion) ; `null` = un nom libre seulement. */
  doctorId: string | null;
  /** Le nom saisi quand aucune fiche n'est désignée. */
  nomLibre: string | null;
  date: string;
  nature: NatureAvantage;
  /** « Congrès SFC 2026 — Billet Alger → Paris ». */
  objet: string;
  /** Accordé, payé compris (DZD). `null` = non attribuable à cette personne. */
  engageDzd: number | null;
  /** Payé (DZD), ≤ engagé. `null` quand l'engagé l'est. */
  payeDzd: number | null;
  societeId: string | null;
  demandeur: string | null;
  /** « SPO-2026-004 », « BC n°2 »… */
  reference: string | null;
  /** La demande Ad & Pro / la prise en charge / le rapport de visite. */
  href: string | null;
  /** Ce qu'il faut savoir d'un montant non attribuable. */
  note?: string | null;
}

/** Ce que l'annuaire dit d'un professionnel. */
export interface ProfessionnelAvantages {
  doctorId: string;
  nom: string;
  specialite: string | null;
  etablissement: string | null;
  wilaya: string | null;
  lettre: string | null;
}

export interface FiltresAvantages {
  annee: number | null;
  societeId: string | null;
  nature: NatureAvantage | null;
  specialite: string | null;
  wilaya: string | null;
}

export const FILTRES_AVANTAGES_VIDES: FiltresAvantages = { annee: null, societeId: null, nature: null, specialite: null, wilaya: null };

/** La clé de la ligne « non rattachés » (tout ce qui ne porte qu'un nom libre). */
export const CLE_NON_RATTACHES = "non-rattaches";
export const LIBELLE_NON_RATTACHES = "Non rattachés à l'annuaire";

const centimes = (n: number) => Math.round(n * 100);
const dzd = (c: number) => c / 100;

/** L'année d'un avantage, à l'heure d'Alger (UTC+1, sans heure d'été) : le 31/12 à 23 h 30 reste dans son année. */
export function anneeDeLAvantage(dateIso: string): number {
  return new Date(Date.parse(dateIso) + 3_600_000).getUTCFullYear();
}

/** Ce qui reste à payer sur un avantage : engagé − payé, jamais négatif. */
export function resteAPayer(a: Pick<Avantage, "engageDzd" | "payeDzd">): number {
  if (a.engageDzd == null) return 0;
  return dzd(Math.max(0, centimes(a.engageDzd) - centimes(a.payeDzd ?? 0)));
}

/** La ligne du registre d'un avantage : sa fiche, sinon les non-rattachés. */
export const cleDuProfessionnel = (a: Pick<Avantage, "doctorId">): string => a.doctorId ?? CLE_NON_RATTACHES;

/**
 * LES FILTRES : année, société, nature sur l'avantage ; spécialité et wilaya sur le professionnel (un nom libre n'en a pas :
 * il sort dès que l'un des deux est posé).
 */
export function filtrerAvantages(avantages: readonly Avantage[], f: FiltresAvantages, pros: ReadonlyMap<string, ProfessionnelAvantages>): Avantage[] {
  return avantages.filter((a) => {
    if (f.annee != null && anneeDeLAvantage(a.date) !== f.annee) return false;
    if (f.societeId && a.societeId !== f.societeId) return false;
    if (f.nature && a.nature !== f.nature) return false;
    if (f.specialite || f.wilaya) {
      const p = a.doctorId ? pros.get(a.doctorId) : undefined;
      if (!p) return false;
      if (f.specialite && p.specialite !== f.specialite) return false;
      if (f.wilaya && p.wilaya !== f.wilaya) return false;
    }
    return true;
  });
}

/** Une ligne du registre — un professionnel (ou les non-rattachés). */
export interface LigneRegistreAvantages {
  cle: string;
  doctorId: string | null;
  nom: string;
  specialite: string | null;
  etablissement: string | null;
  wilaya: string | null;
  lettre: string | null;
  nombre: number;
  payeDzd: number;
  resteDzd: number;
  /** Part du payé total (0–1) ; `null` quand rien n'est payé. */
  part: number | null;
  dernierLe: string | null;
  dernierObjet: string | null;
  /** Les avantages comptés sans montant (non attribuables). */
  sansMontant: number;
  /** Les noms libres de la ligne « non rattachés » (sans doublon). */
  noms: string[];
}

export interface RegistreAvantages {
  lignes: LigneRegistreAvantages[];
  nombre: number;
  payeDzd: number;
  resteDzd: number;
}

/** Les lignes du registre, du plus payé au moins payé (puis l'engagé non payé, puis le nom). Les non-rattachés en dernier. */
export function agregerRegistre(avantages: readonly Avantage[], pros: ReadonlyMap<string, ProfessionnelAvantages>): RegistreAvantages {
  const acc = new Map<string, { a: Avantage[]; paye: number; reste: number }>();
  let totalPaye = 0;
  let totalReste = 0;
  for (const a of avantages) {
    const k = cleDuProfessionnel(a);
    const l = acc.get(k) ?? acc.set(k, { a: [], paye: 0, reste: 0 }).get(k)!;
    l.a.push(a);
    const p = centimes(a.payeDzd ?? 0);
    const r = centimes(resteAPayer(a));
    l.paye += p;
    l.reste += r;
    totalPaye += p;
    totalReste += r;
  }
  const lignes: LigneRegistreAvantages[] = [];
  for (const [cle, l] of acc) {
    const dernier = [...l.a].sort((x, y) => y.date.localeCompare(x.date))[0]!;
    const p = cle === CLE_NON_RATTACHES ? null : pros.get(cle) ?? null;
    lignes.push({
      cle,
      doctorId: cle === CLE_NON_RATTACHES ? null : cle,
      nom: cle === CLE_NON_RATTACHES ? LIBELLE_NON_RATTACHES : p?.nom ?? "Fiche introuvable",
      specialite: p?.specialite ?? null,
      etablissement: p?.etablissement ?? null,
      wilaya: p?.wilaya ?? null,
      lettre: p?.lettre ?? null,
      nombre: l.a.length,
      payeDzd: dzd(l.paye),
      resteDzd: dzd(l.reste),
      part: totalPaye > 0 ? l.paye / totalPaye : null,
      dernierLe: dernier.date,
      dernierObjet: dernier.objet,
      sansMontant: l.a.filter((a) => a.engageDzd == null).length,
      noms: cle === CLE_NON_RATTACHES ? [...new Set(l.a.map((a) => a.nomLibre?.trim()).filter((n): n is string => Boolean(n)))].sort((x, y) => x.localeCompare(y, "fr")) : [],
    });
  }
  lignes.sort((x, y) =>
    Number(x.cle === CLE_NON_RATTACHES) - Number(y.cle === CLE_NON_RATTACHES)
    || y.payeDzd - x.payeDzd || y.resteDzd - x.resteDzd || x.nom.localeCompare(y.nom, "fr"));
  return { lignes, nombre: avantages.length, payeDzd: dzd(totalPaye), resteDzd: dzd(totalReste) };
}

export interface TrancheConcentration { professionnels: number; payeDzd: number; part: number | null }

export interface ConcentrationAvantages {
  /** Professionnels de l'annuaire qui ont reçu au moins un avantage (hors non-rattachés). */
  beneficiaires: number;
  top10: TrancheConcentration;
  /** Les 20 % de bénéficiaires les mieux servis (arrondi au supérieur). */
  top20pct: TrancheConcentration;
}

/**
 * LA CONCENTRATION : la part du payé total qui va aux 10 premiers bénéficiaires, et aux 20 % premiers. Les non-rattachés
 * comptent au total (l'argent est sorti) mais pas au classement (ce n'est pas une personne).
 */
export function concentrationDesAvantages(reg: RegistreAvantages): ConcentrationAvantages {
  const classes = reg.lignes.filter((l) => l.cle !== CLE_NON_RATTACHES).sort((x, y) => y.payeDzd - x.payeDzd);
  const total = centimes(reg.payeDzd);
  const tranche = (n: number): TrancheConcentration => {
    const c = classes.slice(0, n).reduce((s, l) => s + centimes(l.payeDzd), 0);
    return { professionnels: Math.min(n, classes.length), payeDzd: dzd(c), part: total > 0 ? c / total : null };
  };
  return { beneficiaires: classes.length, top10: tranche(10), top20pct: tranche(Math.ceil(classes.length * 0.2)) };
}

export interface TotalAvantages { nombre: number; payeDzd: number; resteDzd: number }

export interface FicheAvantages {
  chronologie: Avantage[];
  parAnnee: (TotalAvantages & { annee: number })[];
  parNature: (TotalAvantages & { nature: NatureAvantage; libelle: string })[];
  total: TotalAvantages;
}

function cumuler(avantages: readonly Avantage[]): TotalAvantages {
  let p = 0;
  let r = 0;
  for (const a of avantages) { p += centimes(a.payeDzd ?? 0); r += centimes(resteAPayer(a)); }
  return { nombre: avantages.length, payeDzd: dzd(p), resteDzd: dzd(r) };
}

/** LA FICHE D'UN PROFESSIONNEL : sa chronologie (la plus récente d'abord), ses totaux par année et par nature. */
export function ficheDuProfessionnel(avantages: readonly Avantage[]): FicheAvantages {
  const chronologie = [...avantages].sort((x, y) => y.date.localeCompare(x.date) || x.objet.localeCompare(y.objet, "fr"));
  const annees = [...new Set(chronologie.map((a) => anneeDeLAvantage(a.date)))].sort((x, y) => y - x);
  const natures = NATURES_AVANTAGE.filter((n) => chronologie.some((a) => a.nature === n));
  return {
    chronologie,
    parAnnee: annees.map((annee) => ({ annee, ...cumuler(chronologie.filter((a) => anneeDeLAvantage(a.date) === annee)) })),
    parNature: natures.map((nature) => ({ nature, libelle: LIBELLE_NATURE_AVANTAGE[nature], ...cumuler(chronologie.filter((a) => a.nature === nature)) })),
    total: cumuler(chronologie),
  };
}

/**
 * LES FICHES FUSIONNÉES : une fiche absorbée pointe sa survivante (chaîne suivie, boucle coupée). Ce qui reste rattaché à
 * l'absorbée (prises en charge, remises de matériel — leurs registres ne se réécrivent pas) remonte ainsi à la survivante.
 */
export function resoudreFusions(fusions: readonly { absorbeeId: string; gardeId: string }[]): (doctorId: string) => string {
  const vers = new Map(fusions.map((f) => [f.absorbeeId, f.gardeId]));
  return (id) => {
    let cur = id;
    const vus = new Set<string>([cur]);
    for (let next = vers.get(cur); next && !vus.has(next); next = vers.get(cur)) { vus.add(next); cur = next; }
    return cur;
  };
}

/**
 * LA PART PAYÉE D'UN MONTANT ATTRIBUÉ : la demande a accordé `accorde` et réglé `paye` ; ce qui revient à une personne
 * (`attribue`) est payé dans la même proportion — jamais au-delà de ce qui lui est attribué.
 */
export function partPayee(attribue: number, accorde: number, paye: number): number {
  if (accorde <= 0 || paye <= 0 || attribue <= 0) return 0;
  return dzd(Math.min(centimes(attribue), Math.round(centimes(attribue) * Math.min(1, paye / accorde))));
}

/** La valeur d'un filtre « toutes les années ». */
export const TOUTES_ANNEES = "toutes";

/**
 * LES FILTRES DE L'ADRESSE (`?annee=2026&societe=…&nature=…&specialite=…&wilaya=…`). Sans année, celle en cours : le
 * registre se lit « par année » ; `toutes` les cumule. Une valeur illisible est ignorée, jamais devinée.
 */
export function lireFiltresAvantages(p: (cle: string) => string | null, anneeCourante: number): FiltresAvantages {
  const brut = p("annee");
  const annee = brut === TOUTES_ANNEES ? null : brut && /^\d{4}$/.test(brut) ? Number(brut) : anneeCourante;
  const nature = p("nature");
  return {
    annee,
    societeId: p("societe") || null,
    nature: estNatureAvantage(nature) ? nature : null,
    specialite: p("specialite") || null,
    wilaya: p("wilaya") || null,
  };
}

/** L'adresse du registre pour ces filtres (et, s'il y en a un, la fiche ouverte). */
export function adresseRegistre(chemin: string, f: FiltresAvantages, pro?: string | null): string {
  const q = new URLSearchParams();
  q.set("annee", f.annee == null ? TOUTES_ANNEES : String(f.annee));
  if (f.societeId) q.set("societe", f.societeId);
  if (f.nature) q.set("nature", f.nature);
  if (f.specialite) q.set("specialite", f.specialite);
  if (f.wilaya) q.set("wilaya", f.wilaya);
  if (pro) q.set("pro", pro);
  return `${chemin}?${q.toString()}`;
}
