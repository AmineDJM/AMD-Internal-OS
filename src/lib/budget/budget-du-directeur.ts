import { domaineParDefaut } from "@/lib/budget-campagne/regles";
import { estDomainePole } from "@/lib/budget/domaines";

/**
 * LE BUDGET D'UN DIRECTEUR — ce qu'il réalloue LIBREMENT (Super Admin, 24/11/2026).
 *
 * « Un directeur réalloue librement entre les lignes de SON budget (ex. le Directeur des opérations sur le budget Ops) ;
 * le TOTAL de son enveloppe est intouchable. Le Super Admin est informé ; le DG ne l'est pas. »
 *
 * SON BUDGET, c'est l'ensemble des enveloppes d'un même exercice que son département tient :
 *   • une enveloppe de PÔLE (Marketing, Regulatory, Operations) de SA société — le pôle du département est celui que la
 *     campagne budgétaire lui a fixé (`BudgetProposal.domaine`, réglable), à défaut celui que son nom dit
 *     (`domaineParDefaut` : « Direction des opérations » → OPERATIONS) ;
 *   • une enveloppe GÉNÉRALE née de la proposition de SON département à une campagne.
 * Deux enveloppes du même budget ont la même `cleDuBudget` : réallouer de l'une à l'autre ne change pas le total du budget.
 * Entre deux budgets, la réallocation est refusée — le total de chacun changerait.
 *
 * Module PUR — lu par l'action (`reallouerCategorie`), par l'écran (la liste « Vers ») et par les tests.
 */

export interface EnveloppeDeBudget {
  id: string;
  domaine: string | null;
  companyId: string | null;
  periodStart: Date | string;
  /** Le département dont la proposition (campagne budgétaire) a ouvert cette enveloppe, s'il y en a une. */
  departementCampagneId?: string | null;
}

export interface DepartementDuDirecteur {
  id: string;
  companyId: string | null;
  /** Le pôle dont il tient le budget (MARKETING, REGULATORY, OPERATIONS) ou GENERAL. */
  domaine: string;
}

/** Une catégorie de tête d'une AUTRE enveloppe du même budget — la liste « Vers » du panneau Réallouer. */
export interface LigneDAutreEnveloppe { id: string; nom: string; envelopeId: string; enveloppe: string; alloue: number }

const annee = (d: Date | string) => new Date(d).getUTCFullYear();

/** Le pôle d'un département : celui fixé par la campagne s'il y en a un, sinon celui que son nom dit. */
export function domaineDuDepartement(d: { name: string; code: string }, domaineDeCampagne?: string | null): string {
  return domaineDeCampagne && domaineDeCampagne.length > 0 ? domaineDeCampagne : domaineParDefaut(d.name, d.code);
}

/** La clé du budget auquel appartient une enveloppe : pôle × société × exercice, ou département × exercice, ou elle seule. */
export function cleDuBudget(e: EnveloppeDeBudget): string {
  if (estDomainePole(e.domaine)) return `POLE:${e.domaine}:${e.companyId ?? "GROUPE"}:${annee(e.periodStart)}`;
  if (e.departementCampagneId) return `DEP:${e.departementCampagneId}:${annee(e.periodStart)}`;
  return `ENV:${e.id}`;
}

/** Ce directeur tient-il le budget de cette enveloppe ? Sa société seulement : un directeur ne voit que la sienne. */
export function dirigeLeBudget(e: EnveloppeDeBudget, departements: readonly DepartementDuDirecteur[]): boolean {
  if (estDomainePole(e.domaine)) return departements.some((d) => d.domaine === e.domaine && d.companyId === e.companyId);
  return Boolean(e.departementCampagneId) && departements.some((d) => d.id === e.departementCampagneId);
}

/**
 * QUI PEUT RÉALLOUER ENTRE CES DEUX ENVELOPPES — le refus, ou `null`. Dans une même enveloppe, la règle d'hier tient
 * (gérer l'enveloppe) et le directeur du budget s'y ajoute. Entre deux enveloppes : le même budget est exigé (sinon le
 * total changerait), puis le directeur de ce budget ou le Super Admin. Ni plafond ni validation : c'est la décision.
 */
export function refusReallocationEntreEnveloppes(p: {
  source: EnveloppeDeBudget;
  cible: EnveloppeDeBudget;
  gereLaSource: boolean;
  estDirecteur: boolean;
  estSuperAdmin: boolean;
}): string | null {
  if (p.source.id === p.cible.id) {
    return p.gereLaSource || p.estDirecteur || p.estSuperAdmin ? null : "Ce budget ne vous est pas confié : seul son directeur ou son gestionnaire le réalloue.";
  }
  if (cleDuBudget(p.source) !== cleDuBudget(p.cible)) {
    return "Ces deux lignes ne sont pas dans le même budget : le total de chacun changerait. Réallouez à l'intérieur d'un seul budget (même pôle, même société, même exercice).";
  }
  return p.estDirecteur || p.estSuperAdmin ? null : "Seul le directeur de ce budget réalloue d'une enveloppe à l'autre.";
}

/** Le total du budget ne bouge jamais : avant = après, au centime près. */
export function refusTotalBudget(avant: number, apres: number): string | null {
  return Math.abs(avant - apres) > 0.005 ? "Le total du budget changerait : la réallocation est annulée." : null;
}
