import type { AdProItemStatus } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI VALIDE UN POSTE, ET DANS QUEL ORDRE (§118.204) — module PUR, lu par l'action, l'écran et la
 * file de « Mon espace ».
 *
 * « Quand c'est la validation qui est faite, c'est d'abord la Direction des opérations, puis celle
 * de la Direction Marketing qui est demandée, qui aussi sélectionne le budget » (Direction, 04/10).
 * Jusqu'ici un poste se tranchait en UNE décision, par quiconque avait la vue globale ou VALIDATE sur
 * le module — la Direction Marketing pouvait accorder sans que la Direction des opérations ait vu, et
 * le budget se choisissait plus tard, dans un geste à part qu'on oubliait.
 *
 * DEUX TEMPS, sur le même poste encore `PENDING` :
 *   1. OPÉRATIONS — la Direction des opérations (rôle `DIRECTION`, §118.138) valide l'opération.
 *      Le fait vit sur le poste (`opsDecidedAt`), le statut ne bouge pas.
 *   2. MARKETING — la Direction Marketing tranche : montant accordé ET budget, exigé à l'accord.
 *
 * Refuser ou renvoyer au demandeur reste possible à chacun des deux temps, motif exigé.
 *
 * ── ON N'ARBITRE PAS SA PROPRE DEMANDE ───────────────────────────────────────────────────────
 *
 * Même règle que le circuit de la demande (§118.142) : quand la DEMANDE a été déposée par la
 * Direction Marketing, le second temps revient à la Direction des opérations — qui tranche alors
 * montant et budget. Quand elle a été déposée par la Direction des opérations, le premier temps est
 * franchi à la soumission, tracé (« on ne fait pas valider à quelqu'un sa propre demande »).
 *
 * Le Super Admin peut tenir chacun des deux temps (suppléance), dans l'ordre.
 *
 * ── LE MATÉRIEL DU STOCK N'EST PAS CONCERNÉ ──────────────────────────────────────────────────
 *
 * Un poste « Matériel du stock » n'engage pas d'argent : il n'a ni budget à choisir ni montant à
 * accorder (§118.167). Il garde sa décision unique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TempsValidation = "OPERATIONS" | "MARKETING";

/** Ce qu'il faut savoir d'une personne pour savoir ce qu'elle tranche. */
export interface Porteur {
  role: string;
  secondaryRole?: string | null;
  /** L'identifiant de la personne : ce qui dit « c'est SA demande », quels que soient ses rôles (audit Ad & Pro, 14/10). */
  id?: string | null;
}

const ROLE_OPERATIONS = "DIRECTION";
const ROLE_MARKETING = "PRODUCT_MANAGER";

const porte = (p: Porteur | null | undefined, role: string) => Boolean(p) && (p!.role === role || p!.secondaryRole === role);

/** La Direction des opérations — le rôle `DIRECTION` (« Direction des opérations »), principal ou secondaire. */
export const estDirectionOperations = (p: Porteur | null | undefined) => porte(p, ROLE_OPERATIONS);
/** La Direction Marketing — `PRODUCT_MANAGER`, principal ou secondaire. */
export const estDirectionMarketingPoste = (p: Porteur | null | undefined) => porte(p, ROLE_MARKETING);
const estSuperAdmin = (p: Porteur | null | undefined) => p?.role === "SUPER_ADMIN";

/** Les faits d'un poste qui disent à quel temps il en est. */
export interface FaitsValidation {
  status: AdProItemStatus;
  opsDecidedAt: Date | string | null;
}

/** Le temps de validation qu'attend un poste, ou `null` s'il n'attend pas de validation. */
export function tempsEnAttente(p: FaitsValidation): TempsValidation | null {
  if (p.status !== "PENDING") return null;
  return p.opsDecidedAt ? "MARKETING" : "OPERATIONS";
}

/**
 * QUI TIENT UN TEMPS DE VALIDATION. Le demandeur de la DEMANDE (pas du poste) décide de qui tient le
 * second temps : la Direction Marketing ne tranche pas les postes de sa propre demande.
 */
export function peutTenir(temps: TempsValidation, personne: Porteur, demandeur: Porteur | null): boolean {
  if (estSuperAdmin(personne)) return true;
  // ON N'ARBITRE PAS SA PROPRE DEMANDE — par la PERSONNE, pas seulement par le rôle (audit Ad & Pro, 14/10). Une personne
  // qui porte les DEUX rôles (Direction des opérations ET Direction Marketing) voyait son premier temps franchi d'office
  // (elle est « Direction des opérations »), puis tenait le second (« demande de la Direction Marketing → la Direction des
  // opérations tranche ») : elle accordait seule montant et budget de sa propre demande. Le Super Admin garde la suppléance.
  if (personne.id && demandeur?.id && personne.id === demandeur.id) return false;
  if (temps === "OPERATIONS") return estDirectionOperations(personne);
  // MARKETING
  if (estDirectionMarketingPoste(demandeur)) return estDirectionOperations(personne);
  return estDirectionMarketingPoste(personne);
}

/** Les rôles à PRÉVENIR quand un poste arrive à ce temps — la même règle que la porte. */
export function rolesAPrevenir(temps: TempsValidation, demandeur: Porteur | null): string[] {
  if (temps === "OPERATIONS") return [ROLE_OPERATIONS];
  return estDirectionMarketingPoste(demandeur) ? [ROLE_OPERATIONS] : [ROLE_MARKETING];
}

/** La soumission franchit-elle d'office le premier temps ? Oui quand la demande vient de la Direction des opérations. */
export function opsFranchiALaSoumission(demandeur: Porteur | null): boolean {
  return estDirectionOperations(demandeur);
}

/** Qui l'on attend, en clair — la phrase de la carte quand le geste n'est pas celui de la personne qui regarde. */
export function libelleTemps(temps: TempsValidation, demandeur: Porteur | null): string {
  if (temps === "OPERATIONS") return "la Direction des opérations";
  return estDirectionMarketingPoste(demandeur) ? "la Direction des opérations (montant et budget)" : "la Direction Marketing (montant et budget)";
}

/** Ce que la personne qui regarde peut trancher sur les postes d'une demande — calculé au serveur. */
export interface DroitsValidation {
  operations: boolean;
  marketing: boolean;
}

export function droitsValidation(personne: Porteur, demandeur: Porteur | null): DroitsValidation {
  return { operations: peutTenir("OPERATIONS", personne, demandeur), marketing: peutTenir("MARKETING", personne, demandeur) };
}
