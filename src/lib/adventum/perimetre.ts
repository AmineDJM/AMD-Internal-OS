/**
 * ADVENTUM BRAIN LIMITÉ À UN PÉRIMÈTRE (Direction, 08/10 : « Droits du Directeur des opérations : … une vue Brain
 * limitée à son périmètre → oui »). Module PUR — testé.
 *
 * Le Super Admin voit tout. Toute autre personne à qui l'on ouvre Adventum Brain (par défaut : le Directeur des
 * opérations) ne lit — et n'agit sur — que les risques du domaine des OPÉRATIONS : marchés et stock PCH, stocks,
 * logistique, ventes, force de vente, couverture terrain, rapports terrain. Jamais le marketing (Ad & Pro,
 * ses bons de commande), le réglementaire, le BD, les RH, les finances ou les budgets.
 *
 * La règle est écrite sur la CATÉGORIE et le MODULE que chaque détecteur pose (`risks.ts`, `risks-plus.ts`) — pas sur
 * un rôle : un détecteur neuf dans une catégorie des opérations entre dans le périmètre sans qu'on y pense, et un
 * détecteur marketing n'y entre pas par ressemblance de mot.
 */

export interface RisqueClasse {
  category: string;
  module: string;
}

/** Les catégories de détecteurs qui sont, entières, du domaine des opérations. */
export const CATEGORIES_OPERATIONS: readonly string[] = ["PCH", "FIELD", "MEDICAL", "QUALITY", "SALES", "STOCKS", "LOGISTICS"];

/** Un module qui nomme un autre domaine l'emporte : « Ad & Pro · Bons de commande » reste au marketing. */
const AUTRE_DOMAINE = /ad\s*&\s*pro|marketing|regulatory|r[ée]glementaire|information m[ée]dicale|recrutement|ressources humaines|budget|comptab|finance|business development|contr[ôo]le de l'ia/i;

/** Un module des opérations, quelle que soit la catégorie que le détecteur a posée. */
// « Promotion médicale » est l'ancien nom de « Visite médicale » : les risques déjà calculés le portent encore.
const MODULE_OPERATIONS = /stock|logisti|pch|vente|force de vente|terrain|promotion m[ée]dicale|visite m[ée]dicale|livraison/i;

export function dansLePerimetreOperations(r: RisqueClasse): boolean {
  if (AUTRE_DOMAINE.test(r.module)) return false;
  return CATEGORIES_OPERATIONS.includes(r.category) || MODULE_OPERATIONS.test(r.module);
}

/** Le filtre d'une personne : tout pour le Super Admin, le domaine des opérations pour toute autre. */
export function filtreDuPerimetre(estSuperAdmin: boolean): (r: RisqueClasse) => boolean {
  return estSuperAdmin ? () => true : dansLePerimetreOperations;
}
