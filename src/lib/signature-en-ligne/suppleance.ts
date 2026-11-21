import type { UserRole } from "@prisma/client";
import { can } from "@/lib/rbac/roles";
import type { QualiteSignature } from "./partage";

/**
 * LE SUPER ADMIN SIGNE-T-IL EN SUPPLÉANCE ? (Direction, 21/11/2026) — vrai quand la personne est Super Admin et ne tient pas,
 * par un de ses rôles, la fonction de la place : la Direction Marketing (`PRODUCT_MANAGER`, la même règle que la porte des
 * postes, `estDirectionMarketingPoste`), les Finances (un rôle dont les droits par défaut signent les BC — « Modifier » sur
 * Bons de commande). Une personne désignée signataire par le Super Admin (droit donné à la main) n'est pas en suppléance :
 * elle signe pour les Finances, c'est sa désignation.
 *
 * Pur (les droits par défaut des rôles sont une table) : testé sans base.
 */
const TIENT: Record<QualiteSignature, (role: string) => boolean> = {
  DIRECTION_MARKETING: (role) => role === "PRODUCT_MANAGER",
  FINANCES: (role) => can(role as UserRole, "PURCHASE_ORDERS", "UPDATE"),
};

export function enSuppleance(qualite: QualiteSignature, p: { role: string; secondaryRole?: string | null } | null | undefined): boolean {
  if (!p) return false;
  const roles = [p.role, p.secondaryRole].filter((r): r is string => Boolean(r));
  if (!roles.includes("SUPER_ADMIN")) return false;
  return !roles.some((r) => r !== "SUPER_ADMIN" && TIENT[qualite](r));
}
