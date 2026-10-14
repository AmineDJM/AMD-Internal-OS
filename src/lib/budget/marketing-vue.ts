/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LA VUE D'ENSEMBLE EN CALCULS PURS (maquette validée par la Direction, 10/2026).
 *
 * Un seul chiffre en tête (le DISPONIBLE = enveloppe − payé − engagé) et son rythme ; ce qui demande une décision
 * (« À traiter ») ; six graphiques et un tableau qui lisent les MÊMES faits sous les MÊMES filtres (période,
 * catégorie, comparaison à N-1) — l'écran, l'Excel, le PDF, le CSV et les diapositives ne peuvent pas diverger.
 *
 * Les faits arrivent déjà lus (`queries/budget-marketing-rapport.ts`) ; ici tout est arithmétique, testée.
 * Module PUR (sa seule dépendance, `cumul-categories.ts`, est pure elle aussi) : il est lu par l'écran client ET par les
 * exports serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { cumulerSousCategories } from "./cumul-categories";

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

/**
 * LE DISPONIBLE = enveloppe − payé − engagé (pas encore payé). L'« engagé » de la vue d'ensemble est TOUT ce qui est
 * promis et pas réglé : les dépenses imputées par la Direction Marketing (BC signés) ET celles déjà consommées qui
 * attendent leur paiement (`budget/depense-poste.ts`). L'onglet Dépenses coupe ce même montant en « engagé » +
 * « consommé en circuit » : son disponible (`tuilesDepenses`) est rigoureusement celui-ci — un test le vérifie.
 */
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

export type GesteAlerte = "REALLOUER" | "IMPUTER" | "AJUSTER" | "PIECES" | "ABSENTES";

export interface Alerte {
  cle: string;
  niveau: "danger" | "warning";
  titre: string;
  detail: string;
  geste: GesteAlerte;
  /** La catégorie concernée (dépassement). */
  categorieId?: string;
  /** L'alerte vient de l'intégration des dépenses réelles Ad & Pro 2026 (pièces, absentes du fichier). */
  integration?: boolean;
}

const fr = (n: number) => dinar(n).toLocaleString("fr-FR").replace(/[  ]/g, " ");
const pluriel = (n: number, s: string, p = `${s}s`) => (n > 1 ? p : s);

/** Ce que l'intégration Ad & Pro 2026 laisse à faire : des pièces à joindre, des éléments « absents du fichier » à trancher. */
export interface ResteIntegration {
  piecesAttendues: number;
  piecesManquantes: number;
  /** Les demandes du lot dont au moins une pièce manque. */
  demandesIncompletes: number;
  /** Les éléments « dans la plateforme, absents du fichier » sans décision (comptés au budget en attendant). */
  aDecider: number;
}

/** Ce qui reste à faire d'un lot, lu sur ses demandes (pièces) et sa liste « absentes du fichier ». */
export function resteIntegration(lot: { demandes: readonly { attendues: number; manquantes: number }[]; absentes: readonly { decision: string | null }[] }): ResteIntegration {
  return {
    piecesAttendues: lot.demandes.reduce((a, d) => a + d.attendues, 0),
    piecesManquantes: lot.demandes.reduce((a, d) => a + d.manquantes, 0),
    demandesIncompletes: lot.demandes.filter((d) => d.manquantes > 0).length,
    aDecider: lot.absentes.filter((a) => a.decision === null).length,
  };
}

/**
 * Ce qui demande une décision, du plus grave au moins grave : une catégorie au-delà de son allocation (payé + engagé
 * > alloué) — ou PAYÉE SANS ALLOCATION — se RÉALLOUE ; des dépenses sans catégorie s'IMPUTENT ; des allocations qui
 * dépassent l'enveloppe s'AJUSTENT dans les Réglages ; l'intégration 2026 laisse des PIÈCES à joindre et des éléments
 * ABSENTS du fichier à décider (garder / sortir).
 */
export function alertesBudget(p: {
  categories: readonly CategorieVue[];
  sansCategorie: { total: number; count: number };
  total: number;
  integration?: ResteIntegration | null;
}): Alerte[] {
  const out: Alerte[] = [];
  const depassees = p.categories
    .filter((c) => c.paye + c.engage > c.alloue + 0.5)
    .sort((a, b) => (b.paye + b.engage - b.alloue) - (a.paye + a.engage - a.alloue));
  for (const c of depassees) {
    const utilise = c.paye + c.engage;
    const sansAllocation = c.alloue <= 0.5;
    out.push({
      cle: `depassement-${c.id}`, niveau: "danger", geste: "REALLOUER", categorieId: c.id,
      titre: sansAllocation ? `${c.nom} : payée sans allocation` : `${c.nom} : ${Math.round(pourcent(utilise, c.alloue))} % de son allocation`,
      detail: sansAllocation
        ? `${fr(c.paye)} payés et ${fr(c.engage)} engagés sur une allocation à 0 · à couvrir depuis une autre catégorie`
        : `${fr(c.paye)} payés et ${fr(c.engage)} engagés pour ${fr(c.alloue)} alloués · dépassement de ${fr(utilise - c.alloue)}`,
    });
  }
  if (p.sansCategorie.total > 0.5) {
    out.push({
      cle: "sans-categorie", niveau: "warning", geste: "IMPUTER",
      titre: `${fr(p.sansCategorie.total)} DZD de dépenses sans catégorie`,
      detail: `${p.sansCategorie.count} ${pluriel(p.sansCategorie.count, "dépense")} à imputer`,
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
  const i = p.integration;
  if (i && i.piecesManquantes > 0) {
    out.push({
      cle: "integration-pieces", niveau: "warning", geste: "PIECES", integration: true,
      titre: `${i.piecesManquantes} ${pluriel(i.piecesManquantes, "pièce manquante", "pièces manquantes")} sur les demandes intégrées`,
      detail: `${i.piecesAttendues - i.piecesManquantes} jointes sur ${i.piecesAttendues} attendues (${i.demandesIncompletes} ${pluriel(i.demandesIncompletes, "demande")}) · elles se joignent à tout moment, sans bloquer le budget`,
    });
  }
  if (i && i.aDecider > 0) {
    out.push({
      cle: "integration-absentes", niveau: "warning", geste: "ABSENTES", integration: true,
      titre: `${i.aDecider} ${pluriel(i.aDecider, "élément « absent du fichier »", "éléments « absents du fichier »")} à décider`,
      detail: "Comptés au budget en attendant : les garder ou les sortir, depuis l'onglet Intégration 2026",
    });
  }
  return out;
}

// ───────────────────────────── L'arbre des catégories (le cumul) ─────────────────────────────

export type CleSante = "MAITRISE" | "A_SURVEILLER" | "DEPASSE" | "SANS_ALLOCATION" | "AUCUNE";

export const LIBELLE_SANTE: Record<CleSante, string> = {
  MAITRISE: "Maîtrisé", A_SURVEILLER: "À surveiller", DEPASSE: "Dépassé", SANS_ALLOCATION: "Sans allocation", AUCUNE: "—",
};

/**
 * La SANTÉ d'une catégorie (mêmes seuils que `cumul-categories.ts` : 80 % = à surveiller, 100 % = dépassé). Une
 * allocation à 0 sur laquelle de l'argent est déjà parti n'est pas « — » : elle est SANS ALLOCATION.
 */
export function santeCategorie(alloue: number, consomme: number): CleSante {
  if (alloue <= 0.5) return consomme > 0.5 ? "SANS_ALLOCATION" : "AUCUNE";
  const r = consomme / alloue;
  if (r >= 1) return "DEPASSE";
  if (r >= 0.8) return "A_SURVEILLER";
  return "MAITRISE";
}

/** Une catégorie lue AVEC ses sous-catégories (le cumul) — et chaque sous-catégorie avec les siennes. */
export interface NoeudArbre {
  id: string;
  nom: string;
  parentId: string | null;
  alloue: number;
  /** Payé et engagé de la catégorie SEULE (imputés directement à elle). */
  payePropre: number;
  engagePropre: number;
  /** Payé et engagé CUMULÉS (la catégorie + toutes ses descendantes). */
  paye: number;
  engage: number;
  /** alloué − payé − engagé (cumulés). */
  reste: number;
  /** (payé + engagé) / alloué, en %. */
  pct: number;
  sante: CleSante;
  /** Ce que les sous-catégories répartissent (leur alloué) — il reste DANS l'alloué de la catégorie. */
  sousAlloue: number;
  /** Les sous-catégories répartissent plus que la catégorie : la carte le signale. */
  surRepartie: boolean;
  /** Ce que la catégorie peut CÉDER par réallocation (`cessible`). */
  cessible: number;
  sous: NoeudArbre[];
}

/**
 * CE QU'UNE CATÉGORIE PEUT CÉDER — son alloué moins le plus grand de deux planchers : ce qui est déjà payé ou engagé
 * (cumulé, sous-catégories comprises) et ce que ses sous-catégories répartissent. Jamais négatif.
 */
export function cessible(p: { alloue: number; payeEngage: number; sousAlloue: number }): number {
  return Math.max(0, p.alloue - Math.max(p.payeEngage, p.sousAlloue, 0));
}

/**
 * L'ARBRE DES CATÉGORIES d'une enveloppe : chaque catégorie de tête avec son CUMUL (`cumul-categories.ts` — une
 * catégorie comprend ses sous-catégories) et ses sous-catégories dépliables. Les montants arrivent PROPRES (la requête
 * rend la part de chaque nœud, sans double compte) : le total de l'enveloppe est la somme des têtes, jamais plus.
 * Tri : alloué décroissant, puis consommé, puis nom.
 */
export function arbreCategories(cats: readonly CategorieBrute[]): NoeudArbre[] {
  const cumul = cumulerSousCategories(cats.map((c) => ({ id: c.id, parentId: c.parentId, allocated: c.allocated, consumed: c.consumed, committed: c.committed })));
  const ids = new Set(cats.map((c) => c.id));
  const estTete = (c: CategorieBrute) => !c.parentId || !ids.has(c.parentId) || c.parentId === c.id;
  const enfants = new Map<string, CategorieBrute[]>();
  for (const c of cats) if (!estTete(c)) enfants.set(c.parentId as string, [...(enfants.get(c.parentId as string) ?? []), c]);
  const tri = (a: NoeudArbre, b: NoeudArbre) => b.alloue - a.alloue || (b.paye + b.engage) - (a.paye + a.engage) || a.nom.localeCompare(b.nom, "fr");
  const construire = (c: CategorieBrute, vus: Set<string>): NoeudArbre => {
    vus.add(c.id);
    const k = cumul.get(c.id);
    const paye = k?.consumed ?? c.consumed, engage = k?.committed ?? c.committed;
    const sous = (enfants.get(c.id) ?? []).filter((x) => !vus.has(x.id)).map((x) => construire(x, vus)).sort(tri);
    const sousAlloue = sous.reduce((a, x) => a + x.alloue, 0);
    return {
      id: c.id, nom: c.name, parentId: estTete(c) ? null : c.parentId, alloue: c.allocated,
      payePropre: c.consumed, engagePropre: c.committed, paye, engage,
      reste: c.allocated - paye - engage, pct: pourcent(paye + engage, c.allocated), sante: santeCategorie(c.allocated, paye + engage),
      sousAlloue, surRepartie: sous.length > 0 && sousAlloue > c.allocated + 0.5,
      cessible: cessible({ alloue: c.allocated, payeEngage: paye + engage, sousAlloue }),
      sous,
    };
  };
  return cats.filter(estTete).map((c) => construire(c, new Set())).sort(tri);
}

/** Les têtes de l'arbre, lues comme la vue d'ensemble les lit (alertes, réallocation). */
export const tetesDeLArbre = (arbre: readonly NoeudArbre[]): CategorieVue[] =>
  arbre.map((n) => ({ id: n.id, nom: n.nom, alloue: n.alloue, paye: n.paye, engage: n.engage }));

/** Une catégorie et toutes ses descendantes (un filtre « catégorie » comprend ses sous-catégories). */
export function idsDeLaCategorie(id: string, cats: readonly { id: string; parentId: string | null }[]): Set<string> {
  const out = new Set<string>([id]);
  let ajoute = true;
  while (ajoute) {
    ajoute = false;
    for (const c of cats) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); ajoute = true; }
  }
  return out;
}

/**
 * « = X en propre + sous-cat A + sous-cat B = total » — la formule du cumul, telle que la carte des Réglages l'écrit
 * (payé + engagé).
 */
export function formuleCumul(n: NoeudArbre): { propre: number; termes: { nom: string; montant: number }[]; total: number } {
  return {
    propre: n.payePropre + n.engagePropre,
    termes: n.sous.map((s) => ({ nom: s.nom, montant: s.paye + s.engage })),
    total: n.paye + n.engage,
  };
}

/** La part de l'enveloppe répartie en catégories de tête : répartie, son %, le non-réparti ou le dépassement. */
export function partRepartie(total: number, tetes: readonly { alloue: number }[]): { reparti: number; pct: number; nonReparti: number; depassement: number } {
  const reparti = tetes.reduce((a, c) => a + c.alloue, 0);
  return { reparti, pct: pourcent(reparti, total), nonReparti: Math.max(0, total - reparti), depassement: Math.max(0, reparti - total) };
}

/**
 * Le panneau d'une catégorie (création / modification) dit l'effet de l'allocation saisie : dans sa catégorie (« les
 * sous-catégories répartiraient X sur Y alloués ») ou dans l'enveloppe (« les catégories répartiraient X sur le total »).
 */
export function effetAllocation(p: {
  total: number;
  categories: readonly { id: string; parentId: string | null; alloue: number }[];
  /** La catégorie modifiée (absente à la création). */
  id?: string | null;
  parentId: string | null;
  alloue: number;
}): { dans: "CATEGORIE" | "ENVELOPPE"; reparti: number; plafond: number; depassement: number } {
  const autres = p.categories.filter((c) => c.id !== p.id && (c.parentId ?? null) === (p.parentId ?? null));
  const reparti = autres.reduce((a, c) => a + c.alloue, 0) + (Number.isFinite(p.alloue) ? p.alloue : 0);
  const plafond = p.parentId ? p.categories.find((c) => c.id === p.parentId)?.alloue ?? 0 : p.total;
  return { dans: p.parentId ? "CATEGORIE" : "ENVELOPPE", reparti, plafond, depassement: Math.max(0, reparti - plafond) };
}

// ───────────────────────────── Réallouer ─────────────────────────────

export const MOTIF_MIN = 5;

/**
 * RÉALLOUER — déplacer un montant d'une catégorie à une autre de la MÊME enveloppe. L'enveloppe ne bouge pas : ce que
 * l'une perd, l'autre le gagne. Le motif est obligatoire (il reste dans l'historique). Une catégorie ne cède jamais
 * plus que son allocation, ni — quand on la connaît — plus que sa part CESSIBLE (`cessible` : ce qui reste libre
 * au-dessus de son payé + engagé ET de ce que ses sous-catégories répartissent).
 */
export function refusReallocation(p: {
  sourceId: string | null | undefined;
  cibleId: string | null | undefined;
  montant: number | null | undefined;
  motif: string | null | undefined;
  source: { envelopeId: string; parentId: string | null; alloue: number; cessible?: number; nom?: string } | null;
  cible: { envelopeId: string; parentId: string | null } | null;
}): string | null {
  if (!p.sourceId || !p.cibleId) return "Choisissez la catégorie qui cède et celle qui reçoit.";
  if (p.sourceId === p.cibleId) return "La catégorie qui cède et celle qui reçoit doivent être différentes.";
  if (!p.source || !p.cible) return "Catégorie introuvable.";
  if (p.source.envelopeId !== p.cible.envelopeId) return "On ne réalloue qu'entre catégories de la même enveloppe.";
  if (p.source.parentId !== null || p.cible.parentId !== null) return "On réalloue entre catégories de tête (une sous-catégorie répartit déjà sa catégorie).";
  if (p.montant == null || !Number.isFinite(p.montant) || p.montant <= 0) return "Indiquez un montant positif.";
  if (p.montant > p.source.alloue + 0.005) return `La catégorie qui cède n'a que ${fr(p.source.alloue)} DZD alloués.`;
  if (p.source.cessible !== undefined && p.montant > p.source.cessible + 0.005) {
    return `${p.source.nom ? `« ${p.source.nom} »` : "La catégorie qui cède"} ne peut céder que ${fr(p.source.cessible)} DZD : le reste de son allocation est déjà payé, engagé ou réparti dans ses sous-catégories.`;
  }
  if (!p.motif || p.motif.trim().length < MOTIF_MIN) return "Le motif est obligatoire : il reste dans l'historique du budget.";
  return null;
}

/**
 * La proposition par défaut de « Réallouer » vers une catégorie : la source qui peut céder le plus, et le montant qui
 * couvre le dépassement de la cible sans excéder ce que la source peut céder.
 */
export function propositionReallocation(
  cibleId: string | null | undefined,
  tetes: readonly { id: string; alloue: number; paye: number; engage: number; cessible: number }[],
): { sourceId?: string; montant?: number; besoin: number } {
  const cible = tetes.find((t) => t.id === cibleId);
  const besoin = cible ? Math.max(0, cible.paye + cible.engage - cible.alloue) : 0;
  const source = [...tetes].filter((t) => t.id !== cibleId && t.cessible > 0.5).sort((a, b) => b.cessible - a.cessible)[0];
  if (!cible || !source) return { besoin };
  return { sourceId: source.id, montant: besoin > 0 ? Math.min(besoin, source.cessible) : undefined, besoin };
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
