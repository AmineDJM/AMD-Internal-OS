import { normaliserTexte, type PlanIntegration } from "./integration-2026";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « DANS LA PLATEFORME, ABSENTES DU FICHIER » — GARDER OU SORTIR, AVANT LA VALIDATION (Direction, 14/10/2026).
 *
 * « À chaque fois que je clique sur en sortir, ça sort carrément et je dois refaire le calcul du fichier à chaque fois. »
 * L'étape 4 de l'assistant effaçait l'aperçu à chaque choix : la table avant → après, la liste et la validation
 * disparaissaient, et il fallait renvoyer et relire le fichier. Désormais le choix est LOCAL à l'assistant : l'aperçu
 * calculé par le serveur reste, et ce module le RECALCULE à l'écran (`appliquerDecisionsLocales`) — chaque élément sorti
 * quitte le consommé (ou l'engagé) de SA catégorie, exactement comme la règle du lot le fera (`verdictSource` :
 * « SORTIR » ⇒ ne compte plus). Les choix partent avec la validation et s'écrivent dans la MÊME transaction que le lot.
 *
 * LA PRÉ-SÉLECTION (`doublonsProbables`) : un élément qui correspond MANIFESTEMENT à une ligne du fichier — même libellé
 * normalisé, ou même montant à ±1 DZD dans la même catégorie — est proposé « En sortir », avec la mention « doublon
 * probable de la ligne Lnn ». Proposé, jamais imposé : le choix se change d'un clic.
 *
 * PUR : importé par l'assistant (navigateur) et par les tests. N'importe que le module pur des décisions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type DecisionAbsente = "GARDER" | "SORTIR";

/** Ce qu'il faut d'une ligne de l'aperçu pour la recalculer. */
export interface LigneRecalculable {
  id: string;
  parentId: string | null;
  apres: { consomme: number; engage: number };
}

/** Ce qu'il faut d'un élément « absent du fichier » pour le recalcul et la pré-sélection. */
export interface AbsenteRecalculable {
  cle: string;
  libelle: string;
  montant: number;
  /** La catégorie de l'enveloppe qu'il charge (`null` : aucune — il ne bouge aucune ligne). */
  categoryId: string | null;
  /** Ce qu'il charge : le consommé, ou l'engagé (une écriture en attente, un engagement). */
  effet: "CONSOMME" | "ENGAGE";
  /** Le choix avec lequel le SERVEUR a calculé l'aperçu (`null` : à décider, compté). */
  decision: DecisionAbsente | null;
}

export interface ApercuRecalculable<L extends LigneRecalculable = LigneRecalculable, A extends AbsenteRecalculable = AbsenteRecalculable> {
  lignes: L[];
  totalApres: { consomme: number; engage: number };
  absentes: A[];
}

const arrondi = (n: number) => Math.round(n * 100) / 100;

/** Un élément compte-t-il au budget avec ce choix ? (la règle du lot : seul « SORTIR » le retire). */
export const compteAvec = (d: DecisionAbsente | null | undefined): boolean => d !== "SORTIR";

/**
 * L'APERÇU AVEC LES CHOIX DE L'ÉCRAN — sans rien redemander au serveur. Pour chaque élément dont le choix local diffère
 * du choix avec lequel l'aperçu a été calculé, son montant quitte (ou retrouve) le consommé ou l'engagé « après » de sa
 * catégorie ; les totaux « après » se recomposent comme au serveur (somme des lignes, au centime). L'« avant » ne bouge pas.
 */
export function appliquerDecisionsLocales<P extends ApercuRecalculable>(apercu: P, decisions: Readonly<Record<string, DecisionAbsente>>): P {
  const delta = new Map<string, { consomme: number; engage: number }>();
  for (const a of apercu.absentes) {
    const local = decisions[a.cle] ?? a.decision;
    const ecart = Number(compteAvec(local)) - Number(compteAvec(a.decision));
    if (ecart === 0 || !a.categoryId) continue;
    const d = delta.get(a.categoryId) ?? { consomme: 0, engage: 0 };
    if (a.effet === "ENGAGE") d.engage += ecart * a.montant; else d.consomme += ecart * a.montant;
    delta.set(a.categoryId, d);
  }
  const lignes = apercu.lignes.map((l) => {
    const d = delta.get(l.id);
    return d ? { ...l, apres: { consomme: arrondi(l.apres.consomme + d.consomme), engage: arrondi(l.apres.engage + d.engage) } } : l;
  });
  const totalApres = delta.size === 0 ? apercu.totalApres : {
    consomme: arrondi(lignes.reduce((s, l) => s + l.apres.consomme, 0)),
    engage: arrondi(lignes.reduce((s, l) => s + l.apres.engage, 0)),
  };
  const absentes = apercu.absentes.map((a) => (decisions[a.cle] && decisions[a.cle] !== a.decision ? { ...a, decision: decisions[a.cle] } : a));
  return { ...apercu, lignes, totalApres, absentes };
}

// ─────────────────────────────── La pré-sélection des doublons probables ───────────────────────────────

/** La correspondance des catégories du plan dans l'enveloppe (celle que la lecture du fichier rend). */
export interface CorrespondanceMin {
  categories: Record<string, { id: string | null; nom?: string }>;
  sousCategories: Record<string, { id: string | null; nom?: string }>;
}

export interface DoublonProbable {
  /** La ligne du fichier (Lnn) à laquelle l'élément correspond. */
  ligne: number;
  raison: "LIBELLE" | "MONTANT";
}

/** La mention affichée à côté de l'élément pré-réglé « En sortir ». */
export const mentionDoublon = (d: DoublonProbable): string =>
  `doublon probable de la ligne L${d.ligne} (${d.raison === "LIBELLE" ? "même libellé" : "même montant, même catégorie"})`;

/** Écart toléré sur le montant : ±1 DZD, en centimes. */
const TOLERANCE_CENTIMES = 100;

interface PosteDuFichier { ligne: number; libelles: string[]; centimes: number; categoryId: string | null }

/**
 * LES DOUBLONS PROBABLES — chaque élément absent qui correspond MANIFESTEMENT à une ligne du fichier :
 *   1. même libellé normalisé que la demande ou le poste du fichier (un libellé générique — « Sponsoring », le nom même
 *      d'une catégorie — ne suffit pas : il ne désigne aucune dépense) ;
 *   2. sinon même montant à ±1 DZD, dans la même catégorie (même ligne de l'enveloppe, ou même catégorie de tête).
 * Une ligne du fichier n'est le double que d'UN élément (les correspondances par libellé d'abord, puis par montant, dans
 * l'ordre de la liste) : deux éléments de même montant ne sont pas tous deux le doublon de la même dépense.
 */
export function doublonsProbables(
  absentes: readonly Pick<AbsenteRecalculable, "cle" | "libelle" | "montant" | "categoryId">[],
  plan: Pick<PlanIntegration, "demandes">,
  correspondance: CorrespondanceMin | null | undefined,
  lignes: readonly Pick<LigneRecalculable, "id" | "parentId">[] = [],
): Map<string, DoublonProbable> {
  const parent = new Map(lignes.map((l) => [l.id, l.parentId]));
  const tete = (id: string | null): string | null => {
    let x = id;
    for (let i = 0; x && parent.get(x) && i < 5; i++) x = parent.get(x) ?? x;
    return x;
  };
  const memeCategorie = (a: string | null, b: string | null) => Boolean(a && b && (a === b || tete(a) === tete(b)));
  const generiques = new Set<string>([
    ...Object.keys(correspondance?.categories ?? {}), ...Object.keys(correspondance?.sousCategories ?? {}),
  ].map(normaliserTexte));
  const postes: PosteDuFichier[] = plan.demandes.flatMap((d) => d.postes.map((p) => {
    const cat = p.sousCategorie ? correspondance?.sousCategories[p.sousCategorie]?.id ?? null : correspondance?.categories[p.categorie]?.id ?? null;
    const libelles = [d.libelle, p.libelle].map(normaliserTexte).filter((l) => l.length >= 4 && !generiques.has(l));
    return { ligne: p.ligne, libelles, centimes: p.montant, categoryId: cat };
  }));

  const out = new Map<string, DoublonProbable>();
  const prises = new Set<number>(); // index des postes déjà appariés
  // 1. Le libellé.
  for (const a of absentes) {
    const l = normaliserTexte(a.libelle);
    if (l.length < 4 || generiques.has(l)) continue;
    const i = postes.findIndex((p, k) => !prises.has(k) && p.libelles.includes(l));
    if (i >= 0) { prises.add(i); out.set(a.cle, { ligne: postes[i].ligne, raison: "LIBELLE" }); }
  }
  // 2. Le montant, dans la même catégorie.
  for (const a of absentes) {
    if (out.has(a.cle) || !a.categoryId || !Number.isFinite(a.montant)) continue;
    const c = Math.round(a.montant * 100);
    const i = postes.findIndex((p, k) => !prises.has(k) && Math.abs(p.centimes - c) <= TOLERANCE_CENTIMES && memeCategorie(p.categoryId, a.categoryId));
    if (i >= 0) { prises.add(i); out.set(a.cle, { ligne: postes[i].ligne, raison: "MONTANT" }); }
  }
  return out;
}

/**
 * LA SÉLECTION PRÉ-COCHÉE — « En sortir » pour chaque doublon probable que la personne n'a pas encore réglé ; ses choix
 * (et ceux déjà proposés une fois, `dejaProposees`) ne sont jamais écrasés.
 */
export function preselection(
  decisions: Readonly<Record<string, DecisionAbsente>>, doublons: ReadonlyMap<string, DoublonProbable>, dejaProposees: ReadonlySet<string> = new Set(),
): Record<string, DecisionAbsente> {
  const out = { ...decisions };
  for (const cle of doublons.keys()) if (!(cle in out) && !dejaProposees.has(cle)) out[cle] = "SORTIR";
  return out;
}
