/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE NOM DU MODULE « VISITE MÉDICALE » — écrit une fois (Super Admin, 11/2026).
 *
 * Le module s'appelait « Promotion médicale ». Seul son NOM change : le rôle « Manager Promotion
 * Médicale », le département RH « Promotion médicale » et les adresses `/medical/*` restent tels
 * quels — ce sont d'autres objets, qui portent le même mot par coïncidence d'histoire.
 *
 * LE JOURNAL GARDE L'ANCIEN NOM : chaque ligne d'audit écrite avant le renommage dit « Promotion
 * médicale », et on ne réécrit pas l'histoire. Tout lecteur qui filtre le journal, ou une file
 * d'actions, par le nom du module passe donc par `estModuleVisite`, qui reconnaît les deux — sinon
 * l'historique d'avant disparaîtrait des écrans le jour du renommage, sans que rien ne le dise.
 *
 * Module PUR — aucune importation : le navigateur et le serveur le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le libellé du module : menu, titres, console d'accès, et la colonne `module` du journal d'audit. */
export const MODULE_AUDIT_VISITE = "Visite médicale";

/** L'ancien nom, tel qu'il reste écrit dans l'historique (journal, lots, files déjà calculées). */
export const ANCIEN_MODULE_AUDIT_VISITE = "Promotion médicale";

/** Les deux noms que le journal peut porter pour ce module — pour un filtre `module: { in: … }`. */
export const MODULES_AUDIT_VISITE: readonly string[] = [MODULE_AUDIT_VISITE, ANCIEN_MODULE_AUDIT_VISITE];

/** Une ligne (journal, file d'actions) appartient-elle au module, sous son nom d'aujourd'hui ou d'hier ? */
export function estModuleVisite(module: string | null | undefined): boolean {
  return module === MODULE_AUDIT_VISITE || module === ANCIEN_MODULE_AUDIT_VISITE;
}
