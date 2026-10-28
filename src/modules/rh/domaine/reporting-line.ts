/**
 * LA LIGNE HIÉRARCHIQUE — UNE seule règle, lue dans les DEUX sens.
 *
 * ── POURQUOI CE MODULE EXISTE ───────────────────────────────────────────────────────────────
 *
 * « Qui est mon N+1 ? » était résolu par une cascade soignée (manager explicite → responsable du
 * département → adjoint → département parent). « Qui sont mes N-1 ? » n'existait pas — et la
 * tentation, pour l'écrire, est d'inverser la cascade à la main : « les employés dont
 * `managerId` est moi, plus ceux du département dont je suis responsable ».
 *
 * Cette inversion-là est FAUSSE, et silencieusement. Elle compte quelqu'un dont le `managerId`
 * explicite désigne une autre personne mais qui appartient à mon département ; elle oublie celui
 * dont le chef de département est inactif et qui remonte donc jusqu'à moi ; elle m'inclut
 * moi-même quand je suis responsable de mon propre département. On obtiendrait deux vérités :
 * un écran « Mon Équipe » qui affiche quelqu'un, et un circuit de validation qui envoie sa
 * demande de congé à quelqu'un d'autre. C'est exactement le genre d'écart qu'on ne découvre que
 * le jour où une demande dort chez une personne qui ne se savait pas concernée.
 *
 * On écrit donc la cascade UNE fois, ici, sous forme PURE — et les deux sens l'appellent. Mon
 * équipe est, par construction, « l'ensemble des gens dont cette fonction dit que je suis le
 * N+1 ». Les deux réponses ne peuvent plus diverger : c'est le même calcul.
 *
 * Module PUR (aucune base) : la cascade est une règle d'organisation, elle doit se lire et se
 * tester sans rien exécuter. L'appelant charge les deux tables et les passe telles quelles.
 */

export interface EmployeeNode {
  id: string;
  fullName: string;
  userId: string | null;
  managerId: string | null;
  departmentId: string | null;
  isActive: boolean;
}

export interface DepartmentNodeLite {
  id: string;
  parentId: string | null;
  headId: string | null;
  deputyId: string | null;
}

/** D'où vient ce N+1 — la même énumération que `ManagerRef`, qui s'appuie sur ce module. */
export type ManagerSource = "MANAGER" | "DEPARTMENT_HEAD" | "DEPARTMENT_DEPUTY" | "PARENT_DEPARTMENT_HEAD";

export interface ResolvedManager {
  employeeId: string;
  fullName: string;
  userId: string | null;
  source: ManagerSource;
}

/** Garde-fou : une hiérarchie mal saisie peut boucler, et une boucle bloque le serveur. */
const MAX_DEPTH = 20;

/**
 * LE N+1 RÉEL D'UN EMPLOYÉ.
 *
 * Cascade, dans l'ordre :
 *   1. le **manager explicite** de l'organigramme ;
 *   2. le **responsable de son département** ;
 *   3. son **adjoint**, quand le responsable manque ou que son compte est inactif — l'adjoint
 *      supplée une absence ;
 *   4. on **remonte au département parent**, autant de niveaux qu'il en faut.
 *
 * Deux règles qui ne sautent pas aux yeux et qui comptent :
 *
 * • **On ne se valide jamais soi-même.** Si l'employé EST le responsable de son propre
 *   département, son N+1 se trouve forcément au-dessus : on escalade au parent sans regarder
 *   l'adjoint — un adjoint est un subordonné qui supplée, pas un supérieur qui arbitre.
 * • **Un compte inactif ne fait pas un N+1.** Une demande adressée à quelqu'un qui ne se
 *   connecte plus ne dort pas : elle disparaît. On continue donc la cascade.
 */
export function resolveManager(
  employeeId: string,
  employees: readonly EmployeeNode[],
  departments: readonly DepartmentNodeLite[],
): ResolvedManager | null {
  const empById = new Map(employees.map((e) => [e.id, e]));
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const emp = empById.get(employeeId);
  if (!emp) return null;

  const ref = (id: string | null, source: ManagerSource): ResolvedManager | null => {
    if (!id || id === emp.id) return null;
    const m = empById.get(id);
    if (!m || !m.isActive) return null;
    return { employeeId: m.id, fullName: m.fullName, userId: m.userId, source };
  };

  const direct = ref(emp.managerId, "MANAGER");
  if (direct) return direct;
  if (!emp.departmentId) return null;

  let current = deptById.get(emp.departmentId) ?? null;
  let level = 0;
  while (current && level++ < MAX_DEPTH) {
    const own = level === 1;
    if (own && current.headId === emp.id) {
      current = current.parentId ? deptById.get(current.parentId) ?? null : null;
      continue;
    }
    const head = ref(current.headId, own ? "DEPARTMENT_HEAD" : "PARENT_DEPARTMENT_HEAD");
    if (head) return head;
    const deputy = ref(current.deputyId, own ? "DEPARTMENT_DEPUTY" : "PARENT_DEPARTMENT_HEAD");
    if (deputy) return deputy;
    current = current.parentId ? deptById.get(current.parentId) ?? null : null;
  }
  return null;
}

/**
 * MES N-1 — définis comme « ceux dont je suis le N+1 », et pas autrement.
 *
 * C'est la définition littérale, et c'est ce qui garantit qu'« untel est dans mon équipe » et
 * « la demande d'untel m'arrive » disent toujours la même chose : les deux passent par
 * `resolveManager`.
 *
 * Seuls les employés ACTIFS sont rendus : une équipe n'est pas un registre historique, et faire
 * apparaître un ancien salarié dans « Mon Équipe » ferait chercher pourquoi il n'a rien à
 * valider.
 */
export function directReportsOf(
  managerEmployeeId: string,
  employees: readonly EmployeeNode[],
  departments: readonly DepartmentNodeLite[],
): EmployeeNode[] {
  return employees.filter(
    (e) => e.isActive
      && e.id !== managerEmployeeId
      && resolveManager(e.id, employees, departments)?.employeeId === managerEmployeeId,
  );
}

/**
 * LA CHAÎNE COMPLÈTE, du N+1 jusqu'au sommet.
 *
 * Bornée en profondeur : une hiérarchie mal saisie (A dirige B qui dirige A) boucle sinon
 * indéfiniment, et l'on ne le découvrirait qu'au premier serveur figé.
 */
export function managementChainOf(
  employeeId: string,
  employees: readonly EmployeeNode[],
  departments: readonly DepartmentNodeLite[],
  maxDepth = 10,
): ResolvedManager[] {
  const chain: ResolvedManager[] = [];
  const vus = new Set<string>([employeeId]);
  let current = employeeId;
  while (chain.length < maxDepth) {
    const m = resolveManager(current, employees, departments);
    if (!m || vus.has(m.employeeId)) break;
    chain.push(m);
    vus.add(m.employeeId);
    current = m.employeeId;
  }
  return chain;
}

/** Encadre-t-il quelqu'un ? La question que pose le menu avant d'afficher « Mon Équipe ». */
export function managesAnyone(
  managerEmployeeId: string,
  employees: readonly EmployeeNode[],
  departments: readonly DepartmentNodeLite[],
): boolean {
  return directReportsOf(managerEmployeeId, employees, departments).length > 0;
}
