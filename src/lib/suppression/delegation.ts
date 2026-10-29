import { userCan, type Module, type SessionUser } from "@/lib/rbac";
import { estDemandeAdProSupprimable } from "@/modules/ad-pro/partage";
import type { DeletableKind } from "@/lib/admin-delete-registry";
import { ROLES_DIRECTEUR_DES_OPERATIONS } from "@/lib/promo-material/validateurs";

/**
 * LE DIRECTEUR DES OPÉRATIONS RANGE ET RÉCUPÈRE DANS SES MODULES (Direction, 06/10 : « permets au directeur des
 * opérations de faire beaucoup d'opérations de suppression, récupération, etc. des modules qu'il gère »).
 *
 * Ce qu'on lui délègue est un RANGEMENT, jamais une destruction : il supprime (déjà, par le droit « supprimer » de
 * ses modules) et il RESTAURE depuis la corbeille ce qui appartient à ces mêmes modules. Détruire pour de bon une
 * entrée de la corbeille reste au seul Super Admin (irréversible).
 *
 * Ses modules sont lus dans SES DROITS, pas dans une liste figée : un type de la corbeille lui est ouvert quand il
 * détient le droit « supprimer » du module dont ce type relève — la console peut donc l'élargir ou le restreindre.
 */

/** Le module RBAC dont relève un type de la corbeille (les types du périmètre des opérations). */
export const MODULE_DU_TYPE: Partial<Record<DeletableKind, Module>> = {
  SALE: "SALES",
  ADMIN_REQUEST: "ADMIN_REQUESTS",
  PCH_TENDER: "PCH",
  PCH_TENDER_LINE: "PCH",
  PROMO_STOCK_ITEM: "PROMO_STOCK",
  SUPPLIER: "LOGISTICS",
};

type Porteur = Pick<SessionUser, "role" | "secondaryRole" | "access">;

/**
 * Les deux libellés de la fonction (« Direction » et « Directeur des opérations »), principal ou secondaire — la MÊME
 * liste que le stock promotionnel et les validateurs (`ROLES_DIRECTEUR_DES_OPERATIONS`) : une seconde liste finirait
 * par en compter un de moins (§118.5).
 */
export const estDirecteurDesOperations = (u: Pick<SessionUser, "role" | "secondaryRole">): boolean =>
  [u.role, u.secondaryRole].some((r) => r != null && (ROLES_DIRECTEUR_DES_OPERATIONS as readonly string[]).includes(r));

/** Peut-il RESTAURER une entrée de ce type depuis la corbeille ? (le Super Admin : toujours) */
export function corbeillePermise(u: Porteur, kind: string): boolean {
  if (u.role === "SUPER_ADMIN") return true;
  if (!estDirecteurDesOperations(u)) return false;
  // Les demandes Ad & Pro : il les supprime déjà (§118.175) — il les récupère aussi.
  if (estDemandeAdProSupprimable(kind)) return true;
  const module = MODULE_DU_TYPE[kind as DeletableKind];
  return module !== undefined && userCan(u as SessionUser, module, "DELETE");
}

/**
 * Peut-il SUPPRIMER (réversiblement) ce type par le bouton commun (`SuperAdminDeleteButton`) ? — la porte de
 * l'écran, sans la ligne : la LIGNE (visible, dans sa portée) est revérifiée par l'action (`superAdminDelete`).
 */
export function suppressionPermise(u: Porteur, kind: string): boolean {
  if (u.role === "SUPER_ADMIN") return true;
  if (!estDirecteurDesOperations(u)) return false;
  const module = MODULE_DU_TYPE[kind as DeletableKind];
  return module !== undefined && userCan(u as SessionUser, module, "DELETE");
}

/** Les types de corbeille qu'il peut voir et restaurer — pour filtrer la liste. */
export function typesDeCorbeillePermis(u: Porteur, tous: readonly string[]): string[] {
  return tous.filter((k) => corbeillePermise(u, k));
}
