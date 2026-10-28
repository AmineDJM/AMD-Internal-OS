/**
 * RBAC — les ENVELOPPES BUDGÉTAIRES et les CATÉGORIES DU DRIVE : gouvernance, gestion, consultation
 * par listes d'accès (rôles / personnes), et le droit budgétaire d'un pôle.
 * Réexporté par la porte `lib/rbac`.
 */

import { DOMAINES, poleDe, type DomainePole } from "../budget/domaines";
import type { Action } from "./modules";
import type { SessionUser } from "./acces";

/**
 * GOUVERNANCE GLOBALE des **enveloppes budgétaires** (créer / supprimer une enveloppe,
 * régler le budget total et surtout DÉCIDER QUI voit ou gère chaque enveloppe) :
 * **strictement le Super Admin**.
 *
 * On NE dérive PLUS ce pouvoir d'un droit de module. Auparavant `BUDGETS:DELETE`
 * suffisait — or `DELETE` fait partie du bundle `MANAGE` (porté par le rôle
 * Finance/Budget, et cochable dans la matrice d'accès quand l'admin ouvre le module) :
 * quiconque « gérait » le module devenait de facto gouverneur et voyait / gérait
 * TOUTES les enveloppes, court-circuitant les listes d'accès par enveloppe (fuite).
 *
 * La délégation se fait désormais **par enveloppe**, granulaire et stricte, via ses
 * listes `managerRoles`/`managerUserIds` (gestion du contenu) et
 * `accessRoles`/`accessUserIds` (consultation). Une personne non listée sur une
 * enveloppe — quel que soit son droit sur le module Budget — ne la voit pas.
 */
export function canManageEnvelopes(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN";
}

/** Listes d'accès d'une enveloppe (visualisation + gestion déléguée). Toutes optionnelles. */
export interface EnvelopeAccessBearer {
  accessRoles?: string[];
  accessUserIds?: string[];
  managerRoles?: string[];
  managerUserIds?: string[];
  /** « MARKETING » / « REGULATORY » / « OPERATIONS » = enveloppe d'un pôle (`lib/budget/domaines.ts`). Absent = générale. */
  domaine?: string | null;
}

/** Le droit du module de budget d'un pôle — lu sans lever d'erreur sur un utilisateur de test sans accès résolu. */
export function peutBudgetDuPole(user: SessionUser, pole: DomainePole, action: Action): boolean {
  return user.access?.modules?.get(DOMAINES[pole].module)?.actions.has(action) ?? false;
}

/** L'enveloppe est tenue par un pôle, et la personne porte le geste demandé sur le module de budget de CE pôle. */
function droitDuPole(user: SessionUser, env: EnvelopeAccessBearer, action: Action): boolean {
  const pole = poleDe(env);
  return pole !== null && peutBudgetDuPole(user, pole, action);
}

/**
 * GESTION du CONTENU d'une enveloppe précise (catégories, allocations, dépenses budgétaires) :
 * un gestionnaire global OU une personne/rôle que l'admin a explicitement désigné(e) sur CETTE
 * enveloppe. Ne confère PAS le droit de modifier l'enveloppe elle-même (montant, période, accès) —
 * cela reste réservé à `canManageEnvelopes`.
 *
 * BUDGETS DES PÔLES (08/10) : une enveloppe MARKETING, REGULATORY ou OPERATIONS se gère aussi par le droit « Modifier »
 * du module de budget de SON pôle — le pôle n'a pas à être listé enveloppe par enveloppe, et le droit d'un pôle ne
 * touche jamais l'enveloppe d'un autre.
 */
export function canManageEnvelope(user: SessionUser, env: EnvelopeAccessBearer): boolean {
  return canManageEnvelopes(user) || (env.managerRoles ?? []).includes(user.role) || (env.managerUserIds ?? []).includes(user.id)
    || droitDuPole(user, env, "UPDATE");
}

/**
 * VISUALISATION d'une enveloppe : quiconque peut la gérer (global ou délégué) OU à qui l'admin
 * a ouvert la consultation (par rôle ou nommément). Défaut = invisible (encadrement strict).
 * Une enveloppe de pôle se lit aussi par le droit « Voir » du module de budget de son pôle.
 */
export function canViewEnvelope(user: SessionUser, env: EnvelopeAccessBearer): boolean {
  return canManageEnvelope(user, env) || (env.accessRoles ?? []).includes(user.role) || (env.accessUserIds ?? []).includes(user.id)
    || droitDuPole(user, env, "VIEW");
}

/**
 * GOUVERNANCE d'une enveloppe de PÔLE (la créer, régler son montant / sa période, la retirer) : le Super Admin, ou le
 * titulaire du geste correspondant sur le module de budget du pôle (Créer, Modifier, Supprimer). Une enveloppe générale
 * — ou celle d'un autre pôle — reste hors de portée. Les LISTES D'ACCÈS ne sont jamais concernées : Super Admin seulement.
 */
export function canGovernPoleEnvelope(user: SessionUser, pole: DomainePole, action: "CREATE" | "UPDATE" | "DELETE", env?: EnvelopeAccessBearer): boolean {
  if (canManageEnvelopes(user)) return true;
  if (env && poleDe(env) !== pole) return false;
  return peutBudgetDuPole(user, pole, action);
}

/** `canGovernPoleEnvelope` pour le pôle Marketing. */
export function canGovernMarketingEnvelope(user: SessionUser, action: "CREATE" | "UPDATE" | "DELETE", env?: EnvelopeAccessBearer): boolean {
  return canGovernPoleEnvelope(user, "MARKETING", action, env);
}

// ─────────── Catégories (espaces partagés) du Drive ───────────
/**
 * Une « catégorie » de Drive (ex. « Promotion Médicale ») est un espace partagé présenté en
 * onglet à côté de « Drive » et « Documents ». Son accès est encadré EXACTEMENT comme une
 * enveloppe budgétaire : rôles/personnes en CONSULTATION (accès) et rôles/personnes
 * GESTIONNAIRES (déposer, organiser, supprimer, régler les accès).
 */
export interface DriveSpaceAccessBearer {
  accessRoles?: string[];
  accessUserIds?: string[];
  managerRoles?: string[];
  managerUserIds?: string[];
}

/**
 * Peut CRÉER une catégorie de Drive : le Super Admin, ou un rôle que le Super Admin a
 * explicitement autorisé (réglage `driveSpaceCreatorRoles`, configuré en Administration).
 */
export function canCreateDriveSpace(user: SessionUser, creatorRoles: string[]): boolean {
  return user.role === "SUPER_ADMIN" || creatorRoles.includes(user.role);
}

/**
 * GESTION d'une catégorie (déposer/organiser/supprimer des fichiers, régler ses accès,
 * la renommer) : Super Admin, ou un rôle/personne « gestionnaire » désigné sur CETTE
 * catégorie. Le créateur y est ajouté d'office (managerUserIds).
 */
export function canManageDriveSpace(user: SessionUser, space: DriveSpaceAccessBearer): boolean {
  return user.role === "SUPER_ADMIN" || (space.managerRoles ?? []).includes(user.role) || (space.managerUserIds ?? []).includes(user.id);
}

/**
 * VISUALISATION d'une catégorie : quiconque peut la gérer OU à qui la consultation est
 * ouverte (par rôle ou nommément). Défaut = invisible (encadrement strict, comme les enveloppes).
 */
export function canViewDriveSpace(user: SessionUser, space: DriveSpaceAccessBearer): boolean {
  return canManageDriveSpace(user, space) || (space.accessRoles ?? []).includes(user.role) || (space.accessUserIds ?? []).includes(user.id);
}
