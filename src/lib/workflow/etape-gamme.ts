/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉTAPE DU NATIONAL SALES APPARTIENT AU SUPERVISEUR DE LA GAMME (audit 27/10/2026, ADPRO-06).
 *
 * L'étape préliminaire nomme un RÔLE (`NATIONAL_SALES`) : tous ceux qui le portaient pouvaient la
 * trancher, et tous étaient prévenus. Or le National Sales est le N+1 de SES KAM — la gamme du dossier
 * le désigne (`BusinessUnit.supervisorId`), c'est déjà lui qu'ouvre la porte de la fiche (§118.184).
 * Le National Sales d'une autre gamme recevait l'alerte d'un dossier qu'il ne peut pas ouvrir, et
 * l'approuvait ou le refusait par son identifiant, à la place du N+1 réel.
 *
 * La règle : quand la gamme du dossier a un superviseur qui PORTE le rôle, l'étape lui revient — à lui
 * et à qui y est nommé par un AUTRE rôle de l'étape (le Super Admin passe partout, plus haut). Une gamme
 * sans superviseur, ou dont le superviseur ne porte pas le rôle, garde le comportement d'avant : bloquer
 * l'étape faute de désignation ferait attendre une demande que personne ne peut trancher (§118.16).
 *
 * Module PUR : aucun import. Le moteur lit la gamme et l'appelle ; l'écran du circuit aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ROLE_LIE_A_LA_GAMME = "NATIONAL_SALES";

export interface Porteur {
  id: string;
  role: string;
  secondaryRole?: string | null;
}

const porte = (p: Porteur, role: string) => p.role === role || p.secondaryRole === role;

/** Le superviseur qui TIENT l'étape, ou `null` si l'étape reste ouverte à tout le rôle. */
export function superviseurQuiTientLEtape(actorRoles: readonly string[], superviseur: Porteur | null): Porteur | null {
  if (!actorRoles.includes(ROLE_LIE_A_LA_GAMME) || !superviseur) return null;
  return porte(superviseur, ROLE_LIE_A_LA_GAMME) ? superviseur : null;
}

/** Vrai quand l'acteur n'entre dans l'étape QUE par le rôle lié à la gamme, sans en être le superviseur. */
export function horsDeSaGamme(actorRoles: readonly string[], acteur: Porteur, superviseur: Porteur | null): boolean {
  const tenant = superviseurQuiTientLEtape(actorRoles, superviseur);
  if (!tenant || tenant.id === acteur.id) return false;
  return !actorRoles.some((r) => r !== ROLE_LIE_A_LA_GAMME && porte(acteur, r));
}

/** Les rôles à prévenir quand l'étape est atteinte : le rôle lié à la gamme part si un superviseur la tient (il est prévenu nommément). */
export function rolesAPrevenir<R extends string>(roles: readonly R[], superviseur: Porteur | null): R[] {
  return superviseurQuiTientLEtape(roles, superviseur) ? roles.filter((r) => r !== ROLE_LIE_A_LA_GAMME) : [...roles];
}
