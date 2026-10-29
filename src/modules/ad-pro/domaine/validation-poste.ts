import type { AdProItemStatus } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI ACCEPTE UN POSTE — module PUR, lu par l'action, l'écran et la file de « Mon espace ».
 *
 * RÈGLE DU 27/10/2026 (Direction) : « celui qui accepte un poste, c'est la Direction Marketing ».
 * Les postes ne naissent qu'APRÈS la prévalidation de la demande — qui a déjà traversé le N+1 et le
 * Directeur des opérations — : un second passage chez le Directeur des opérations, poste par poste,
 * ferait valider deux fois la même chose. UN SEUL TEMPS donc, sur le poste `PENDING` :
 *
 *   MARKETING — la Direction Marketing accepte : montant accordé ET budget, exigés à l'accord ; ou
 *   refuse, ou renvoie au demandeur, motif exigé.
 *
 * Le temps « OPÉRATIONS » de la règle du 04/10 (§118.204) n'est plus attendu : un poste soumis le
 * franchit d'office, et c'est tracé (`opsDecidedAt`). Un poste resté en attente de ce temps sous
 * l'ancienne règle passe directement à la Direction Marketing.
 *
 * ── ON N'ACCEPTE PAS LES POSTES DE SA PROPRE DEMANDE ─────────────────────────────────────────
 *
 * Par la PERSONNE (audit Ad & Pro, 14/10) : sur une demande déposée par un membre de la Direction
 * Marketing, c'est une AUTRE personne de la Direction Marketing qui accepte ses postes. Le Super
 * Admin garde la suppléance.
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

/** Le Directeur des opérations (27/10/2026) — et, tant que son compte n'existe pas, la Direction qui le suppléait. */
const ROLES_OPERATIONS = ["OPERATIONS_DIRECTOR", "DIRECTION"] as const;
const ROLE_MARKETING = "PRODUCT_MANAGER";

const porte = (p: Porteur | null | undefined, role: string) => Boolean(p) && (p!.role === role || p!.secondaryRole === role);

/** Le Directeur des opérations — `OPERATIONS_DIRECTOR` (ou la Direction qui le suppléait), principal ou secondaire. */
export const estDirectionOperations = (p: Porteur | null | undefined) => ROLES_OPERATIONS.some((r) => porte(p, r));
/** La Direction Marketing — `PRODUCT_MANAGER`, principal ou secondaire. */
export const estDirectionMarketingPoste = (p: Porteur | null | undefined) => porte(p, ROLE_MARKETING);
const estSuperAdmin = (p: Porteur | null | undefined) => p?.role === "SUPER_ADMIN";

/** Les faits d'un poste qui disent à quel temps il en est. */
export interface FaitsValidation {
  status: AdProItemStatus;
  opsDecidedAt: Date | string | null;
}

/**
 * Le temps de validation qu'attend un poste, ou `null` s'il n'attend pas de validation. Depuis le
 * 27/10/2026, il n'y en a plus qu'un : la Direction Marketing — `opsDecidedAt` n'est plus lu.
 */
export function tempsEnAttente(p: FaitsValidation): TempsValidation | null {
  return p.status === "PENDING" ? "MARKETING" : null;
}

/**
 * QUI TIENT UN TEMPS DE VALIDATION. `OPERATIONS` n'est plus attendu (il reste lisible pour l'historique).
 * `MARKETING` : la Direction Marketing — jamais la personne qui a déposé la demande.
 */
export function peutTenir(temps: TempsValidation, personne: Porteur, demandeur: Porteur | null): boolean {
  if (estSuperAdmin(personne)) return true;
  // ON N'ACCEPTE PAS LES POSTES DE SA PROPRE DEMANDE — par la PERSONNE, pas seulement par le rôle (audit Ad & Pro, 14/10).
  if (personne.id && demandeur?.id && personne.id === demandeur.id) return false;
  if (temps === "OPERATIONS") return estDirectionOperations(personne);
  return estDirectionMarketingPoste(personne);
}

/** Les rôles à PRÉVENIR quand un poste arrive à ce temps — la même règle que la porte. */
export function rolesAPrevenir(temps: TempsValidation, _demandeur: Porteur | null): string[] {
  return temps === "OPERATIONS" ? [...ROLES_OPERATIONS] : [ROLE_MARKETING];
}

/** La soumission franchit-elle d'office le premier temps ? Toujours, depuis le 27/10/2026 (tracé). */
export function opsFranchiALaSoumission(_demandeur: Porteur | null): boolean {
  return true;
}

/** Qui l'on attend, en clair — la phrase de la carte quand le geste n'est pas celui de la personne qui regarde. */
export function libelleTemps(temps: TempsValidation, _demandeur: Porteur | null): string {
  return temps === "OPERATIONS" ? "le Directeur des opérations" : "la Direction Marketing (montant et budget)";
}

/** Ce que la personne qui regarde peut trancher sur les postes d'une demande — calculé au serveur. */
export interface DroitsValidation {
  operations: boolean;
  marketing: boolean;
}

export function droitsValidation(personne: Porteur, demandeur: Porteur | null): DroitsValidation {
  return { operations: peutTenir("OPERATIONS", personne, demandeur), marketing: peutTenir("MARKETING", personne, demandeur) };
}
