import { userCan, type SessionUser } from "@/lib/rbac";
import { peutEcrireMessagesPromo } from "@/lib/sfe/tournee";

/**
 * QUI VOIT QUOI DANS LE MARKETING COCKPIT — des règles nommées, lues par l'onglet (`nav-tabs.ts`), la page et les
 * tuiles. La porte du cockpit reste le module `MARKETING_COCKPIT` ; ces règles s'y AJOUTENT, elles n'élargissent rien.
 *
 *   • LE MARCHÉ (IQVIA, PCH, Nomenclature) : à qui l'a DÉJÀ — la porte de l'Explorateur produits (`PRODUCT_EXPLORER`),
 *     qui lit les mêmes fichiers (`lib/market/data`). Décision de la Direction (07/10) : on n'élargit pas l'accès au marché ;
 *     les autres ne voient ni l'onglet ni la tuile (pas d'aguiche). La porte était Business Development › Intelligence
 *     marché : ce module est RETIRÉ du service (`modules-retired.ts`), `userCan` y répond non pour tout le monde, et
 *     l'onglet était mort pour tous, Super Admin compris (24/11/2026). L'Explorateur est la clé VIVANTE qui gouverne ces
 *     données : qui y lit le marché le lit aussi dans le cockpit, et la console l'ouvre ou le ferme aux deux endroits.
 *   • L'ARGENT (engagé Ad & Pro, enveloppe) : à qui lit Budget Marketing, les Budgets ou Ad & Pro — les montants ne s'ouvrent pas par le
 *     seul cockpit, que la Force de vente reçoit aussi par défaut.
 */
export function peutVoirMarcheCockpit(user: SessionUser): boolean {
  return userCan(user, "PRODUCT_EXPLORER", "VIEW");
}

export function peutVoirArgentCockpit(user: SessionUser): boolean {
  return userCan(user, "BUDGET_MARKETING", "VIEW") || userCan(user, "BUDGETS", "VIEW") || userCan(user, "SPONSORING", "VIEW");
}

/**
 * ÉCRIRE LES MESSAGES — deux clés, et les deux comptent :
 *   • la LISTE DE RÔLES du Super Admin (`promoMessageAuthorRoles`, Administration › Réglages) — par défaut, la
 *     Direction Marketing (07/10 : « elle écrit ses messages ») ;
 *   • le GESTE sur le module du cockpit (créer / modifier / retirer), réglé personne par personne dans
 *     Administration › Accès : une restriction posée sur quelqu'un l'emporte sur son rôle.
 * Le Super Admin écrit toujours.
 */
export function peutEcrireMessagesCockpit(
  user: SessionUser,
  rolesAutorises: readonly string[],
  geste: "CREATE" | "UPDATE" | "DELETE" = "UPDATE",
): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  return peutEcrireMessagesPromo(user, rolesAutorises) && userCan(user, "MARKETING_COCKPIT", geste);
}
