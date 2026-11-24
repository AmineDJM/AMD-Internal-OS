/**
 * QUI EST « LE DIRECTEUR » — le responsable de chaque département dans l'organigramme (Super Admin, 24/11/2026).
 *
 * « Directeur = le responsable de chaque département dans l'organigramme. Il ne voit que SA société, sauf le DG (et le
 * Super Admin). » La règle est FACTUELLE, comme pour le recrutement et la campagne budgétaire : on dirige un département
 * parce que sa fiche en est le responsable (`Department.headId`), pas parce qu'un rôle le dit. Ses pouvoirs (réallouer
 * librement dans son budget, autoriser les formations pour le Directeur des opérations) se lisent ICI, une fois.
 *
 * L'ADJOINT N'EST PAS LE DIRECTEUR — « pas de sous-délégation à un adjoint » (même décision). La campagne budgétaire et le
 * budget de fonctionnement comptent l'adjoint parmi ceux qui PRÉPARENT (`polesTenusPar`, `headedDepartmentIds`) ; les
 * pouvoirs propres au directeur, eux, ne se prêtent pas.
 *
 * Module PUR — l'appelant charge l'organigramme (`infra/directeurs.ts`), la règle se teste sans base.
 */

export interface DepartementOrganigramme {
  id: string;
  name: string;
  code: string;
  /** La société du département ; `null` = département transverse au groupe. */
  companyId: string | null;
  /** Le compte de son responsable (fiche employé `head`), `null` sans responsable ou sans compte. */
  headUserId: string | null;
}

/** Le directeur d'un département : le compte de son responsable dans l'organigramme. Jamais l'adjoint. */
export function directeurDuDepartement(d: Pick<DepartementOrganigramme, "headUserId">): string | null {
  return d.headUserId ?? null;
}

/** Cette personne dirige-t-elle ce département ? */
export function estDirecteurDe(userId: string, d: Pick<DepartementOrganigramme, "headUserId">): boolean {
  return Boolean(userId) && directeurDuDepartement(d) === userId;
}

/** Les départements que cette personne dirige. */
export function departementsDirigesPar<D extends Pick<DepartementOrganigramme, "headUserId">>(userId: string, deps: readonly D[]): D[] {
  return deps.filter((d) => estDirecteurDe(userId, d));
}

const plie = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Ce département est-il la Direction des opérations ? Lu sur le nom (sans casse ni accents : « Direction des Opérations »,
 * « Opérations », « Direction Operations ») ou sur le code (OPERATIONS, DIR_OPS…). Lu aussi par la masse salariale de la
 * force de vente (`budget-operations/force-de-vente.ts`) : une seule définition.
 */
export function estDirectionDesOperations(d: { name: string; code: string }): boolean {
  const nom = plie(d.name).toLowerCase().trim();
  const code = plie(d.code).toUpperCase().replace(/[^A-Z]/g, "");
  return /^(direction\s+(des?|d')\s*)?operations?$/.test(nom) || /^direction\s+(des?|d')\s*operations?\b/.test(nom)
    || /^(DIR(ECTION)?)?(OPS|OPERATIONS?)$/.test(code);
}

/**
 * LE DIRECTEUR DES OPÉRATIONS D'UNE SOCIÉTÉ — le responsable de la Direction des opérations de CETTE société ; à défaut,
 * celui d'une Direction des opérations transverse au groupe (`companyId` nul). Jamais celui d'une autre société : un
 * directeur ne voit que la sienne. Plusieurs responsables possibles (deux départements reconnus) : tous, sans doublon.
 */
export function directeursDesOperationsDeLaSociete(deps: readonly DepartementOrganigramme[], companyId: string | null): string[] {
  const ops = deps.filter((d) => estDirectionDesOperations(d) && d.headUserId);
  const deLaSociete = companyId ? ops.filter((d) => d.companyId === companyId) : [];
  const retenus = deLaSociete.length > 0 ? deLaSociete : ops.filter((d) => d.companyId === null);
  return [...new Set(retenus.map((d) => d.headUserId as string))];
}

/**
 * QUI AUTORISE UNE FORMATION (« toutes les formations, réglementaires comprises, passent par l'autorisation du Directeur
 * des opérations », 24/11/2026) — dans l'ordre :
 *   1. le responsable de la Direction des opérations de la société de la formation (l'organigramme : la règle du directeur) ;
 *   2. à défaut d'organigramme renseigné, les comptes actifs au rôle de Directeur des opérations — la même personne vue par
 *      son rôle, celle que l'information médicale saisit déjà (`medical-info/decideur.ts`) : une formation ne reste pas
 *      sans personne pour l'autoriser parce qu'une fiche n'est pas rattachée ;
 *   3. à défaut, le Super Admin (souverain, il tranche déjà toute marche).
 * Le demandeur n'est jamais son propre décideur. `repli` dit que la formation est partie au Super Admin.
 */
export function autorisateursDeFormation(i: {
  parOrganigramme: readonly string[];
  parRole: readonly string[];
  superAdmins: readonly string[];
  requesterId: string | null;
}): { userIds: string[]; repli: boolean } {
  const sauf = (ids: readonly string[]) => [...new Set(ids)].filter((id) => id && id !== i.requesterId);
  const org = sauf(i.parOrganigramme);
  if (org.length > 0) return { userIds: org, repli: false };
  const role = sauf(i.parRole);
  if (role.length > 0) return { userIds: role, repli: false };
  return { userIds: sauf(i.superAdmins), repli: true };
}
