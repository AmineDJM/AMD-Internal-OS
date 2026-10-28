import type { NotificationType, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { anyRoleFilter, getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI PRÉVENIR QU'UN BON DE COMMANDE ATTEND SA SIGNATURE (§118.176).
 *
 * Hier, `notifyRoles(["FINANCE_BUDGET_MANAGER"])` : le RÔLE, rien que le rôle. Le module « Bons de
 * commande » s'ouvre désormais « à qui le Super Admin veut », et la liste des rôles ne dit plus qui
 * signe. Deux défauts, dans les deux sens, s'il restait la règle :
 *   • une personne à qui le Super Admin a RETIRÉ le module (ou la signature) recevrait toujours
 *     « Bon de commande à signer », avec un lien vers un écran qu'elle ne peut pas ouvrir ;
 *   • une personne qu'il a DÉSIGNÉE nommément — un comptable sans le rôle des Finances — ne serait
 *     jamais prévenue, et la file attendrait quelqu'un qui ne sait pas qu'on l'attend.
 *
 * ── LE POUVOIR N'EST PAS LA FILE (§118.153) ─────────────────────────────────────────────────
 *
 * Les défauts du module donnent la signature à la Direction et au Directeur Général, parce qu'ils
 * l'avaient hier (ils modifiaient les Finances) : c'est un POUVOIR. La file, elle, est le MÉTIER des
 * Finances — et c'est elles seules qu'on prévenait. Prévenir chaque détenteur du pouvoir ferait
 * arriver chaque bon de commande chez le Directeur Général, qui croirait qu'on attend sa signature,
 * et une notification qui arrive partout cesse d'être lue (§118.32). Sont donc prévenus :
 *   • les rôles dont c'est le métier (`ROLES_SIGNATAIRES_DE_METIER`) — le comportement d'hier ;
 *   • toute personne que la CONSOLE désigne nommément pour signer (accès personnalisé au module,
 *     « Modifier » coché) — c'est la décision du Super Admin, elle vaut désignation.
 * Et dans les deux cas, seulement si la signature est EFFECTIVE : l'accès se relit par `getAccess`,
 * la seule résolution du dépôt (blocage, rôle secondaire, accès personnalisé) — en recalculer une
 * seconde ici divergerait au premier réglage (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les rôles dont la signature des bons de commande est le MÉTIER — prévenus par défaut. */
export const ROLES_SIGNATAIRES_DE_METIER: readonly UserRole[] = ["FINANCE_BUDGET_MANAGER"];

/** Les personnes à prévenir — actives, et dont la signature est effective. */
export async function signatairesAPrevenir(): Promise<string[]> {
  const [parMetier, parConsole] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, ...anyRoleFilter([...ROLES_SIGNATAIRES_DE_METIER]) },
      select: { id: true, role: true, secondaryRole: true },
    }),
    prisma.userAccess.findMany({
      where: { module: "PURCHASE_ORDERS", canView: true, canUpdate: true, user: { isActive: true } },
      select: { user: { select: { id: true, role: true, secondaryRole: true } } },
    }),
  ]);
  const candidats = new Map<string, { id: string; role: UserRole; secondaryRole: UserRole | null }>();
  for (const u of parMetier) candidats.set(u.id, u);
  for (const a of parConsole) candidats.set(a.user.id, a.user);

  const retenus: string[] = [];
  for (const u of candidats.values()) {
    const acteur: SessionUser = { id: u.id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(u.id, u.role) };
    if (userCan(acteur, "PURCHASE_ORDERS", "UPDATE")) retenus.push(u.id);
  }
  return retenus;
}

/**
 * PRÉVENIR LES SIGNATAIRES — la seule porte d'envoi des notifications « à signer ». Rend le nombre
 * de personnes prévenues ; ne lève jamais (une notification manquée ne défait pas l'aiguillage).
 */
export async function notifierSignatairesBC(input: { type: NotificationType; title: string; body?: string; link: string }): Promise<number> {
  const ids = await signatairesAPrevenir().catch(sansBloquer("signataires.notifierSignatairesBC.signatairesAPrevenir", [] as string[]));
  for (const userId of ids) await notifyUser({ ...input, userId });
  return ids.length;
}
