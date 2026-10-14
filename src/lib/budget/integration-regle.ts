/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUDGET D'UNE ENVELOPPE APRÈS UNE INTÉGRATION DE DÉPENSES RÉELLES (Ad & Pro 2026, Direction 10/2026).
 *
 * Une fois un lot d'intégration validé sur une enveloppe, ce qui compte à son budget est, et n'est QUE :
 *
 *   (a) les POSTES HISTORIQUES du lot — payés, à LEUR date, dans LEUR catégorie ou sous-catégorie, nature dérivée du
 *       poste (`consommationHistorique`) ;
 *   (b) ce qui NAÎT APRÈS la date d'intégration (une écriture, une ligne budgétaire, un ordre, un engagement) : le circuit
 *       habituel continue, et compte comme aujourd'hui ;
 *   (c) jamais deux fois la même dépense : une source rattachée à une demande que le lot a créée ou complétée — ou à un
 *       poste historique — est REMPLACÉE par le fichier (le paiement de 53 350 du webinaire SAI ne s'ajoute pas aux
 *       53 550 retenus).
 *
 * Ce qui comptait avant et ne correspond à aucune ligne du fichier n'est ni gardé en silence ni effacé : il apparaît
 * dans « Dans la plateforme, absentes du fichier », où l'on décide, élément par élément, de le GARDER dans le budget ou
 * de l'en SORTIR. Tant que rien n'est décidé, il reste compté (« à décider ») — une intégration ne fait pas disparaître
 * une dépense sans qu'on l'ait dit.
 *
 * UNE SEULE RÈGLE, lue par TOUS les lecteurs de budget (vue d'ensemble, total des enveloppes, engagé, Budget Marketing,
 * rapport, exports, pré-remplissage des campagnes, risques) — le cliquet `integration-regle.cliquet.test.ts` échoue si
 * l'un d'eux ne passe pas par `queries/budget-integration.ts`.
 *
 * Module PUR, sans aucun import.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type DecisionAbsente = "GARDER" | "SORTIR";

/** La règle d'UN lot actif, sur UNE enveloppe. */
export interface RegleIntegration {
  lotId: string;
  enveloppeId: string;
  /** La date d'intégration : ce qui naît APRÈS compte. */
  integreLe: Date;
  /** Les demandes créées ou complétées par le lot (`TYPE:id`, la clé de `demandeDuPoste`). */
  demandes: ReadonlySet<string>;
  /** Les postes historiques du lot (créés ou complétés). */
  postesHistoriques: ReadonlySet<string>;
  /** Les choix « garder / sortir » des éléments absents du fichier, par clé de source. */
  decisions: ReadonlyMap<string, DecisionAbsente>;
}

/**
 * UNE SOURCE de consommation ou d'engagement, telle que la règle la juge.
 *
 * Clés : `TX:<écriture>`, `LIGNE:<ligne budgétaire>`, `POSTE:<poste>` (l'engagé d'un poste), `ORDRE:<ordre>` (un ordre
 * émis non réglé, d'un poste ou hors poste).
 */
export interface SourceBudget {
  cle: string;
  /** Quand elle est entrée dans le budget : la plus ancienne des dates connues (l'ordre qui l'a écrite, sa création). */
  neeLe: Date;
  /** La demande d'origine (`TYPE:id`), quand on la connaît. */
  demande: string | null;
  /** Le poste d'origine, quand on le connaît. */
  posteId: string | null;
}

export type RaisonVerdict =
  | "POSTE_HISTORIQUE"
  | "APRES_INTEGRATION"
  | "REMPLACEE_PAR_LE_FICHIER"
  | "ABSENTE_A_DECIDER"
  | "ABSENTE_GARDEE"
  | "ABSENTE_SORTIE";

export interface Verdict {
  compte: boolean;
  raison: RaisonVerdict;
}

export const LIBELLE_RAISON: Record<RaisonVerdict, string> = {
  POSTE_HISTORIQUE: "Payée par un poste historique : le fichier la porte",
  APRES_INTEGRATION: "Née après l'intégration : compte comme d'habitude",
  REMPLACEE_PAR_LE_FICHIER: "Remplacée par la ligne du fichier (jamais deux fois)",
  ABSENTE_A_DECIDER: "Absente du fichier — à décider (comptée en attendant)",
  ABSENTE_GARDEE: "Absente du fichier — gardée dans le budget",
  ABSENTE_SORTIE: "Absente du fichier — sortie du budget",
};

/** LE VERDICT d'une source. L'ordre des questions est la règle : poste historique, puis date, puis demande, puis choix. */
export function verdictSource(regle: RegleIntegration, s: SourceBudget): Verdict {
  if (s.posteId && regle.postesHistoriques.has(s.posteId)) return { compte: false, raison: "POSTE_HISTORIQUE" };
  if (s.neeLe.getTime() > regle.integreLe.getTime()) return { compte: true, raison: "APRES_INTEGRATION" };
  if (s.demande && regle.demandes.has(s.demande)) return { compte: false, raison: "REMPLACEE_PAR_LE_FICHIER" };
  const choix = regle.decisions.get(s.cle);
  if (choix === "SORTIR") return { compte: false, raison: "ABSENTE_SORTIE" };
  return { compte: true, raison: choix === "GARDER" ? "ABSENTE_GARDEE" : "ABSENTE_A_DECIDER" };
}

/** Une source est-elle « dans la plateforme, absente du fichier » (quel que soit le choix) ? */
export function estAbsenteDuFichier(v: Verdict): boolean {
  return v.raison === "ABSENTE_A_DECIDER" || v.raison === "ABSENTE_GARDEE" || v.raison === "ABSENTE_SORTIE";
}

/** Trier un lot de sources : celles qui comptent, et les autres avec leur raison. */
export function trierSources<T extends SourceBudget>(regle: RegleIntegration | null, sources: readonly T[]): { comptees: T[]; ecartees: (T & { verdict: Verdict })[]; absentes: (T & { verdict: Verdict })[] } {
  if (!regle) return { comptees: [...sources], ecartees: [], absentes: [] };
  const comptees: T[] = [];
  const ecartees: (T & { verdict: Verdict })[] = [];
  const absentes: (T & { verdict: Verdict })[] = [];
  for (const s of sources) {
    const verdict = verdictSource(regle, s);
    if (verdict.compte) comptees.push(s);
    else ecartees.push({ ...s, verdict });
    if (estAbsenteDuFichier(verdict)) absentes.push({ ...s, verdict });
  }
  return { comptees, ecartees, absentes };
}

/** Un poste historique, tel que le budget le lit. */
export interface PosteHistorique {
  id: string;
  categoryId: string | null;
  montant: number;
  payeLe: Date;
  kind: string;
  libelle: string;
  demande: string | null;
  ligne: number | null;
}

/** (a) — LA CONSOMMATION HISTORIQUE d'une enveloppe sur une période : chaque poste payé, à sa date, dans sa catégorie. */
export function consommationHistorique(
  postes: readonly PosteHistorique[], categories: ReadonlySet<string>, from?: Date | null, to?: Date | null,
): { parCategorie: Map<string, number>; lignes: PosteHistorique[] } {
  const parCategorie = new Map<string, number>();
  const lignes: PosteHistorique[] = [];
  for (const p of postes) {
    if (!p.categoryId || !categories.has(p.categoryId) || !(p.montant > 0)) continue;
    if (from && p.payeLe.getTime() < from.getTime()) continue;
    if (to && p.payeLe.getTime() > to.getTime()) continue;
    parCategorie.set(p.categoryId, (parCategorie.get(p.categoryId) ?? 0) + p.montant);
    lignes.push(p);
  }
  return { parCategorie, lignes };
}

/** Additionner deux cartes catégorie → montant. */
export function ajouterParCategorie(cible: Map<string | null, number>, source: ReadonlyMap<string, number>): void {
  for (const [k, v] of source) cible.set(k, (cible.get(k) ?? 0) + v);
}

/** La règle d'un lot, depuis ses lignes lues (forme plate, pour le serveur et les tests). */
export function regleDuLot(l: {
  lotId: string; enveloppeId: string; integreLe: Date;
  demandes: readonly { type: string; id: string }[];
  postesHistoriques: readonly string[];
  decisions: readonly { cleSource: string; decision: string }[];
}): RegleIntegration {
  return {
    lotId: l.lotId,
    enveloppeId: l.enveloppeId,
    integreLe: l.integreLe,
    demandes: new Set(l.demandes.map((d) => `${d.type}:${d.id}`)),
    postesHistoriques: new Set(l.postesHistoriques),
    decisions: new Map(l.decisions.filter((d) => d.decision === "GARDER" || d.decision === "SORTIR").map((d) => [d.cleSource, d.decision as DecisionAbsente])),
  };
}

/** La plus ancienne de plusieurs dates (une source est née quand la première de ses traces est née). */
export function plusAncienne(...dates: (Date | null | undefined)[]): Date {
  const valides = dates.filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()));
  if (valides.length === 0) return new Date(0);
  return new Date(Math.min(...valides.map((d) => d.getTime())));
}
