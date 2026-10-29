/**
 * RBAC — les VÉRIFICATIONS sur l'accès résolu : `userCan`, `estPrete`, l'assistant IA, l'accès par
 * annuaire, les spécialités, BD › Projets, modules accessibles et portée d'un module.
 * Réexporté par la porte `lib/rbac`.
 */

import type { AccessScope } from "@prisma/client";
import { peutAnnuaire as regleAnnuaire, ouvertParSection, type AnnuaireAccordable, type FaitsAnnuaire, type GesteAnnuaire } from "../annuaires/acces"; // module PUR, zéro import → aucun cycle
import { MODULES, type Action, type Module } from "./modules";
import { hasRole } from "./roles";
import type { EffectiveAccess, SessionUser } from "./acces";

/**
 * L'ASSISTANT IA EST-IL OUVERT À CETTE PERSONNE ? Le module `ASSISTANT_IA` en VUE — le Super Admin
 * l'a d'office, les autres seulement si l'accès leur est ouvert (Administration › Accès). Un droit
 * qui ne tiendrait qu'à un intérim ne compte pas : l'assistant parle au nom de son utilisateur.
 */
export function peutUtiliserAssistantIA(u: SessionUser): boolean {
  return userCan(u, "ASSISTANT_IA", "VIEW") && !estPrete(u, "ASSISTANT_IA", "VIEW");
}

/** Le refus, écrit une fois — page, actions et confirmation disent la même phrase. */
export const REFUS_ASSISTANT_IA = "L'assistant ne vous est pas ouvert.";

/** Does the user's effective access permit this action on this module? */
export function userCan(user: SessionUser, module: Module, action: Action): boolean {
  return user.access.modules.get(module)?.actions.has(action) ?? false;
}

/**
 * CE DROIT NE TIENT-IL QU'À UN INTÉRIM ? (§118.196, lot E4 — audit 360°, M13)
 *
 * Un intérim prête des gestes de MÉTIER ; il ne prête pas le pouvoir d'accorder des droits. Les
 * portes qui ouvrent ou ferment un accès — l'accès d'un tiers à une entité, la fermeture d'un compte,
 * la désignation ou la validation d'un intérim — refusent un droit qui n'est que prêté : sinon
 * l'intérimaire des RH ouvrirait des entités, fermerait des comptes et validerait des intérims au nom
 * d'une personne absente, trois gestes qui survivent au retour du titulaire.
 *
 * Nommé `est…` exprès : la dérivation des contrats ne le prend pas pour une garde, et les portes
 * gardent leur `userCan(user, "RH", "UPDATE")` littéral — `porte` et `gardes` ne bougent pas.
 */
export function estPrete(user: { access: EffectiveAccess }, module: Module, action: Action): boolean {
  return user.access.pretes?.get(module)?.has(action) ?? false;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ACCÈS PAR ANNUAIRE (§118.147) — la règle pure vit au socle (`annuaires/acces.ts`) ; ici on
 * ne fait que lui porter les faits d'une personne. UNE lecture, pour les onglets, les pages, les
 * chargeurs, les actions et la conversation : une porte qui recopierait la règle à sa façon
 * finirait par ouvrir ce qu'une autre ferme (§118.5, §118.71).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function faitsAnnuaire(user: SessionUser): FaitsAnnuaire {
  return {
    peut: (module, geste) => userCan(user, module as Module, geste),
    sections: user.access.modules.get("DIRECTORIES")?.sections ?? new Set<string>(),
    tientPersonnesParRole: [user.role, user.secondaryRole ?? null].some((r) => r === "SUPER_ADMIN" || r === "DIRECTION"),
  };
}

/** Cette personne peut-elle faire ce geste dans cet annuaire — par son module OU par la console ? */
export function peutAnnuaire(user: SessionUser, cle: AnnuaireAccordable, geste: GesteAnnuaire): boolean {
  return regleAnnuaire(faitsAnnuaire(user), cle, geste);
}

/**
 * L'annuaire lui est-il ouvert PAR LA CONSOLE ? C'est ce qui décide de la PORTÉE des lignes : un
 * annuaire ouvert par la console s'ouvre en entier (un référentiel, pas un portefeuille), là où
 * le module garde la portée de son métier (les praticiens d'un délégué).
 */
export function annuaireOuvertParConsole(user: SessionUser, cle: AnnuaireAccordable, geste: GesteAnnuaire): boolean {
  return ouvertParSection(faitsAnnuaire(user), cle, geste);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENTIEL DES SPÉCIALITÉS — qui le gère (§118.180).
 *
 * Décision de la Direction (04/10/2026) : « donne la gestion/création des spécialités au directeur
 * des opérations ». Les DEUX rôles qui portent ce nom (`DIRECTION`, « Direction des opérations », et
 * `OPERATIONS_DIRECTOR`, « Directeur des Opérations » — la lecture de `promo-material/validateurs.ts`)
 * gèrent tout le référentiel : créer, renommer, fusionner, retirer, rattacher un libellé hérité. Le
 * second n'a de la Promotion médicale que la LECTURE : sans cette règle, il aurait vu l'onglet sans un
 * seul bouton. Les autres gardent ce qu'ils avaient — le droit de la Promotion médicale, geste par geste.
 *
 * LA DIRECTION MARKETING LE GÈRE AUSSI (05/10/2026, §118.209) : « donne la gestion des spécialités, dans
 * Force de vente, dans un onglet à part au marketing — ils peuvent ajouter, supprimer, modifier ».
 * Elle n'a de la Promotion médicale (`MEDICAL`) et de la Force de vente (`SALES_PLANNING`) que la
 * LECTURE ; lui donner l'écriture de l'un ou l'autre module lui ouvrirait les praticiens, les visites,
 * les Business Units, les affectations (§118.16). La règle est donc PRÉCISE : le rôle `PRODUCT_MANAGER`
 * (principal OU secondaire), tous les gestes, sur le seul référentiel. Le Manager Promotion médicale
 * le gère déjà par son droit de module (MANAGE) — on ne lui ajoute pas un rôle que la console pourrait
 * resserrer : « garde ce qu'il avait ». Le Super Admin passe par `userCan`.
 *
 * UNE lecture pour l'onglet, la page et les cinq actions : une porte qui recopierait la règle
 * finirait par ouvrir un bouton que l'action refuse (§118.5, §118.83). Le rôle se lit principal OU
 * secondaire (`hasRole`), comme les autres lectures du « directeur des opérations ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type GesteSpecialites = "VIEW" | "CREATE" | "UPDATE" | "DELETE";

export function peutGererSpecialites(user: SessionUser, geste: GesteSpecialites): boolean {
  if (hasRole(user, "DIRECTION") || hasRole(user, "OPERATIONS_DIRECTOR") || hasRole(user, "PRODUCT_MANAGER")) return true;
  return userCan(user, "MEDICAL", geste);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BD › PROJETS — un module à part, réglé depuis la console (§118.163).
 *
 * Décision de la Direction (30/09/2026) : « le module Projets dans Business Development : donne la
 * permission au Super Admin de gérer l'accès au module depuis Super Admin ».
 *
 * Le registre survivait au retrait de Market Intelligence par une porte DÉDUITE (« quiconque voit
 * Regulatory »), qui ne passait pas par le module retiré. Elle avait raison sur ce point et le garde
 * — `BUSINESS_DEVELOPMENT` reste retiré, `userCan` y répond NON pour tout le monde, sinon rouvrir
 * Projets rouvrirait Market Intelligence, ses actions et l'accès générique d'Adam (§118.16). Mais
 * une porte déduite ne se RÈGLE pas : aucune case de la console ne l'ouvrait ni ne la fermait.
 * Elle devient donc un module, `BD_PROJECTS`, et ces deux prédicats le lisent.
 *
 * VOIR — le droit de lecture du module (par défaut : chaque rôle qui voit Regulatory, voir sous
 * `PERMISSIONS`). Ce que l'écran montre d'un projet — ses dossiers — reste filtré par
 * `regulatoryVisibleWhere` : ouvrir le registre à quelqu'un ne lui ouvre aucun dossier.
 *
 * GÉRER — le droit de MODIFIER le module (par défaut : le Super Admin seul, qui tient tous les
 * modules). Créer et supprimer lisent leur geste propre (`CREATE`, `DELETE`) dans les actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function canViewBdProjects(user: SessionUser): boolean {
  return userCan(user, "BD_PROJECTS", "VIEW");
}

export function canManageBdProjects(user: SessionUser): boolean {
  return userCan(user, "BD_PROJECTS", "UPDATE");
}

/** Modules the user can at least view — drives the sidebar. */
export function accessibleModules(user: SessionUser): Module[] {
  return MODULES.filter((m) => user.access.modules.has(m));
}

export function moduleScope(user: SessionUser, module: Module): AccessScope | null {
  return user.access.modules.get(module)?.scope ?? null;
}
