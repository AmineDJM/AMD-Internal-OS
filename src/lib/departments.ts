import { cache } from "react";
import { prisma } from "@/lib/prisma";
import {
  resolveManager, managementChainOf,
  type DepartmentNodeLite, type EmployeeNode, type ManagerSource,
} from "@/modules/rh/partage";

/**
 * DÉPARTEMENTS — structure de l'entreprise et hiérarchie réelle (N+1).
 *
 * Deux axes complémentaires, volontairement séparés :
 *   • le RÔLE dit ce qu'une personne a le droit de faire (RBAC, `MODULE_PERMISSIONS`) ;
 *   • le DÉPARTEMENT dit sur quel périmètre elle agit, QUI la valide et quel budget
 *     elle consomme.
 *
 * Le **N+1 réel** d'un employé est résolu en cascade, du plus précis au plus général :
 *   1. son **manager explicite** (`Employee.managerId`, posé dans l'organigramme) ;
 *   2. sinon le **responsable de son département** (`Department.head`) ;
 *   3. sinon, en remontant, le responsable du **département parent**, etc. (N niveaux).
 * L'**adjoint** (`Department.deputy`) prend le relais si le responsable est l'employé
 * lui-même (on ne se valide pas soi-même) ou n'est pas renseigné.
 */

// Mémoïsation par requête si React `cache` est disponible ; sinon (tests, hors requête) no-op.
// La ligne hiérarchique est demandée par la barre de navigation ET par les écrans qu'elle
// ouvre : sans mémo, les deux mêmes lectures repartaient à chaque rendu.
const perRequest: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

// ───────────────────────────── Arbre des départements ─────────────────────────────

export interface DepartmentNode {
  id: string;
  name: string;
  code: string;
  description: string | null;
  parentId: string | null;
  /** Entité de rattachement (null = transverse au groupe). */
  companyId: string | null;
  companyName: string | null;
  /** Profondeur dans l'arbre : 0 = département de tête. */
  depth: number;
  headId: string | null;
  headName: string | null;
  deputyId: string | null;
  deputyName: string | null;
  /** Effectif rattaché DIRECTEMENT à ce département. */
  members: number;
  /** Effectif cumulé (ce département + tous ses sous-départements). */
  totalMembers: number;
  children: DepartmentNode[];
}

type RawDept = {
  id: string; name: string; code: string; description: string | null; parentId: string | null;
  companyId: string | null; company: { name: string; shortName: string | null } | null;
  headId: string | null; deputyId: string | null;
  head: { fullName: string } | null;
  deputy: { fullName: string } | null;
  _count: { members: number };
};

function buildTree(rows: RawDept[], parentId: string | null, depth: number): DepartmentNode[] {
  return rows
    .filter((d) => d.parentId === parentId)
    .map((d) => {
      const children = buildTree(rows, d.id, depth + 1);
      const node: DepartmentNode = {
        id: d.id, name: d.name, code: d.code, description: d.description, parentId: d.parentId, depth,
        companyId: d.companyId, companyName: d.company?.shortName ?? d.company?.name ?? null,
        headId: d.headId, headName: d.head?.fullName ?? null,
        deputyId: d.deputyId, deputyName: d.deputy?.fullName ?? null,
        members: d._count.members,
        totalMembers: d._count.members + children.reduce((a, c) => a + c.totalMembers, 0),
        children,
      };
      return node;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Arbre des départements (N niveaux) avec responsable, adjoint et effectifs.
 * `companyId` restreint à une ENTITÉ ; `undefined` = toutes les entités (vue groupe).
 * Les départements transverses (sans entité) sont toujours inclus.
 */
export async function getDepartmentTree(
  companyId?: string | null,
  /**
   * Les sociétés auxquelles la personne a droit, quand aucune n'est sélectionnée : « toutes les
   * entités » veut dire « toutes les MIENNES », jamais toutes celles qui existent (§118.177).
   * Absent = aucune restriction (vue groupe, ou appelant qui ne lit pas pour une personne).
   */
  parmi?: string[] | null,
): Promise<DepartmentNode[]> {
  const rows = (await prisma.department.findMany({
    where: companyId
      ? { OR: [{ companyId }, { companyId: null }] }
      : parmi
        ? { OR: [{ companyId: { in: parmi } }, { companyId: null }] }
        : {},
    include: {
      company: { select: { name: true, shortName: true } },
      head: { select: { fullName: true } },
      deputy: { select: { fullName: true } },
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  })) as unknown as RawDept[];
  return buildTree(rows, null, 0);
}

/** Liste à plat pour les sélecteurs : libellé indenté selon la profondeur. */
export interface DepartmentOption { id: string; label: string; depth: number; parentId: string | null; companyId: string | null }

export function flattenTree(nodes: DepartmentNode[], out: DepartmentOption[] = []): DepartmentOption[] {
  for (const n of nodes) {
    out.push({ id: n.id, label: `${"— ".repeat(n.depth)}${n.name}`, depth: n.depth, parentId: n.parentId, companyId: n.companyId });
    flattenTree(n.children, out);
  }
  return out;
}

export async function getDepartmentOptions(companyId?: string | null): Promise<DepartmentOption[]> {
  return flattenTree(await getDepartmentTree(companyId));
}

// ───────────────────────────── Descendance / membres ─────────────────────────────

/** Ids d'un département ET de tous ses sous-départements (récursif, N niveaux). */
export async function getDepartmentSubtreeIds(departmentId: string): Promise<string[]> {
  const all = await prisma.department.findMany({ select: { id: true, parentId: true } });
  const byParent = new Map<string | null, string[]>();
  for (const d of all) byParent.set(d.parentId, [...(byParent.get(d.parentId) ?? []), d.id]);
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const child of byParent.get(id) ?? []) walk(child);
  };
  walk(departmentId);
  return out;
}

/** Employés d'un département (option : en incluant les sous-départements). */
export async function getDepartmentMembers(
  departmentId: string,
  opts: { includeSubDepartments?: boolean; activeOnly?: boolean } = {},
): Promise<{ id: string; fullName: string; position: string | null; userId: string | null; departmentId: string | null }[]> {
  const ids = opts.includeSubDepartments ? await getDepartmentSubtreeIds(departmentId) : [departmentId];
  return prisma.employee.findMany({
    where: { departmentId: { in: ids }, ...(opts.activeOnly === false ? {} : { isActive: true }) },
    select: { id: true, fullName: true, position: true, userId: true, departmentId: true },
    orderBy: { fullName: "asc" },
  });
}

/** Comptes applicatifs des membres d'un département (pour notifier / habiliter). */
export async function getDepartmentUserIds(departmentId: string, includeSubDepartments = true): Promise<string[]> {
  const members = await getDepartmentMembers(departmentId, { includeSubDepartments });
  return members.map((m) => m.userId).filter((id): id is string => Boolean(id));
}

// ───────────────────────────── Hiérarchie réelle (N+1) ─────────────────────────────

export interface ManagerRef {
  employeeId: string;
  fullName: string;
  userId: string | null;
  /** D'où vient ce N+1 : manager explicite, responsable du département, ou d'un parent. */
  source: ManagerSource;
}

/**
 * LES DEUX TABLES DE LA LIGNE HIÉRARCHIQUE, chargées d'un coup.
 *
 * La cascade elle-même vit dans `hr/reporting-line.ts` — PURE, testée, et appelée aussi bien
 * pour « qui est mon N+1 » que pour « qui sont mes N-1 ». Ce module ne fait plus que lui porter
 * les données : c'est ce qui garantit que « untel est dans mon équipe » et « la demande d'untel
 * m'arrive » disent toujours la même chose. Écrire la règle deux fois, c'est se donner rendez-vous
 * avec le jour où elles divergent.
 */
export const loadReportingLine = perRequest(
  async (): Promise<{ employees: EmployeeNode[]; departments: DepartmentNodeLite[] }> => {
    const [employees, departments] = await Promise.all([
      prisma.employee.findMany({
        select: { id: true, fullName: true, userId: true, managerId: true, departmentId: true, isActive: true },
      }),
      prisma.department.findMany({ select: { id: true, parentId: true, headId: true, deputyId: true } }),
    ]);
    return { employees, departments };
  },
);

/**
 * Résout le **N+1 réel** d'un employé (voir la cascade en tête de fichier).
 * Ne se renvoie JAMAIS lui-même : si l'employé est le responsable de son propre
 * département, on passe à l'adjoint puis on remonte au département parent.
 */
export async function getManagerOf(employeeId: string): Promise<ManagerRef | null> {
  const { employees, departments } = await loadReportingLine();
  return resolveManager(employeeId, employees, departments);
}

/**
 * Chaîne hiérarchique complète, du N+1 jusqu'au sommet (sans boucle infinie).
 *
 * UNE lecture des deux tables, puis la chaîne se déroule en mémoire. L'ancienne version
 * rappelait `getManagerOf` à chaque échelon, et chacun rechargeait TOUS les départements :
 * une chaîne de cinq niveaux faisait dix allers-retours pour la même donnée.
 */
export async function getManagementChain(employeeId: string, maxDepth = 10): Promise<ManagerRef[]> {
  const { employees, departments } = await loadReportingLine();
  return managementChainOf(employeeId, employees, departments, maxDepth);
}

/** N+1 d'un COMPTE applicatif (résolu via sa fiche employé). */
export async function getManagerOfUser(userId: string): Promise<ManagerRef | null> {
  const emp = await prisma.employee.findUnique({ where: { userId }, select: { id: true } });
  return emp ? getManagerOf(emp.id) : null;
}

/**
 * `viewerUserId` est-il le N+1 (direct ou plus haut dans la chaîne) de `subjectUserId` ?
 * Utilisé par les circuits de validation « le responsable hiérarchique valide ».
 */
export async function isManagerOfUser(viewerUserId: string, subjectUserId: string): Promise<boolean> {
  const subject = await prisma.employee.findUnique({ where: { userId: subjectUserId }, select: { id: true } });
  if (!subject) return false;
  const chain = await getManagementChain(subject.id);
  return chain.some((m) => m.userId === viewerUserId);
}

/** Le département (et ses parents) d'un employé — fil d'Ariane « Direction › Ventes › Nord ». */
export async function getDepartmentPath(departmentId: string): Promise<{ id: string; name: string }[]> {
  const depts = await prisma.department.findMany({ select: { id: true, name: true, parentId: true } });
  const byId = new Map(depts.map((d) => [d.id, d]));
  const path: { id: string; name: string }[] = [];
  let cur = byId.get(departmentId);
  let guard = 0;
  while (cur && guard++ < 20) {
    path.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}
