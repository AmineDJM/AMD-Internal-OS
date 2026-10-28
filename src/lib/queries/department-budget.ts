import { refusAnnulationRallonge } from "@/lib/annulations/regles";
import { prisma } from "@/lib/prisma";
import { myCompanyScope } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import { entryCost } from "@/modules/rh/partage";
import {
  mergeGrants, canViewDepartmentBudget, editableKindsOn, EMPTY_GRANT,
  type DeptBudgetViewRow, type DeptBudgetGrant, type BudgetSetter, type GrantSubject, type DeptBudgetKind,
} from "@/lib/department-budget";


/**
 * Tableau « budget par département » pour une année, VU PAR UNE PERSONNE PRÉCISE.
 *
 * Chaque ligne porte ce que cette personne a le droit d'y faire — c'est calculé ici, une fois,
 * plutôt qu'à l'affichage : une case verrouillée dans l'interface ne protège rien si le serveur
 * ne sait pas pourquoi elle l'est.
 *
 * La masse salariale CONSOMMÉE n'est pas une saisie : elle est calculée depuis la paie réelle
 * des membres du département sur l'exercice. C'est le seul chiffre qui permette de dire si le
 * budget RH tient — un montant ressaisi à la main dirait ce qu'on espère, pas ce qui se passe.
 *
 * Le fonctionnement, lui, n'a pas d'équivalent : aucune dépense n'est aujourd'hui imputée à un
 * département. On affiche donc l'alloué sans inventer une consommation — mieux vaut une colonne
 * vide qu'un chiffre qui ressemble à une mesure sans en être une.
 */
export async function getDepartmentBudgets(
  viewer: { id: string; role: string; secondaryRole?: string | null },
  rights: BudgetSetter,
  canViewBudgetsModule: boolean,
  year: number,
): Promise<DeptBudgetViewRow[]> {
  // Le tableau reste dans la portée d'entité en cours : le budget d'Adventum n'est pas celui
  // de Pharmagène. Les départements transverses (sans entité) restent visibles.
  const scope = await myCompanyScope(viewer.id);

  const departments = await prisma.department.findMany({
    where: scope ? { OR: [{ companyId: scope }, { companyId: null }] } : {},
    select: {
      id: true, name: true, parentId: true,
      company: { select: { name: true, shortName: true } },
      members: { select: { id: true } },
    },
    orderBy: { name: "asc" },
  });
  if (departments.length === 0) return [];

  const ids = departments.map((d) => d.id);
  const [budgets, payroll, expenses, accessRows] = await Promise.all([
    prisma.departmentBudget.findMany({ where: { departmentId: { in: ids }, year }, select: { departmentId: true, kind: true, amount: true } }),
    // Masse salariale réelle : le COÛT EMPLOYEUR de chaque ligne de paie de l'exercice (repli
    // brut + primes − retenues sur les mois saisis avant ce champ — voir `hr/payroll-cost.ts`),
    // reventilé sur le département de l'employé. Sommer des bruts sous-estimait ce que les
    // salaires coûtent VRAIMENT — et c'est ce chiffre-là qu'on oppose au budget.
    prisma.payrollEntry.findMany({
      where: { year, employee: { departmentId: { in: ids } } },
      select: { employeeId: true, employerCost: true, gross: true, bonuses: true, deductions: true },
    }),
    // Moyens généraux et budget métier : la consommation RÉELLE, imputée dépense par dépense.
    // La page affichait jusqu'ici une colonne vide faute de source ; il y en a une désormais.
    prisma.departmentBudgetExpense.groupBy({
      by: ["departmentId", "kind"],
      where: { departmentId: { in: ids }, year },
      _sum: { amount: true },
    }),
    // Autorisations : celles des départements affichés + la règle GÉNÉRALE (departmentId null).
    prisma.departmentBudgetAccess.findMany({
      where: { OR: [{ departmentId: { in: ids } }, { departmentId: null }] },
    }),
  ]);

  const empDept = new Map<string, string>();
  for (const d of departments) for (const m of d.members) empDept.set(m.id, d.id);

  const consumedByDept = new Map<string, number>();
  for (const p of payroll) {
    const dept = empDept.get(p.employeeId);
    if (!dept) continue;
    consumedByDept.set(dept, (consumedByDept.get(dept) ?? 0) + entryCost({
      employerCost: p.employerCost != null ? toNumber(p.employerCost) : null,
      gross: toNumber(p.gross), bonuses: toNumber(p.bonuses), deductions: toNumber(p.deductions),
    }));
  }

  const spentByDeptKind = new Map<string, number>();
  for (const e of expenses) {
    spentByDeptKind.set(`${e.departmentId}:${e.kind}`, toNumber(e._sum.amount ?? 0));
  }

  const asGrant = (r: (typeof accessRows)[number]): DeptBudgetGrant => ({
    accessRoles: r.accessRoles, accessUserIds: r.accessUserIds,
    operatingRoles: r.operatingRoles, operatingUserIds: r.operatingUserIds,
    hrRoles: r.hrRoles, hrUserIds: r.hrUserIds,
    activityRoles: r.activityRoles, activityUserIds: r.activityUserIds,
  });
  const general = accessRows.find((r) => r.departmentId === null);
  const ownById = new Map(accessRows.filter((r) => r.departmentId).map((r) => [r.departmentId!, r]));
  const generalGrant = general ? asGrant(general) : null;

  const amountOf = (deptId: string, kind: DeptBudgetKind) =>
    toNumber(budgets.find((b) => b.departmentId === deptId && b.kind === kind)?.amount ?? 0);
  const spentOf = (deptId: string, kind: DeptBudgetKind) => spentByDeptKind.get(`${deptId}:${kind}`) ?? 0;

  // Chemin complet : deux sous-départements « Ville » de deux pôles différents ne doivent pas
  // se confondre dans un tableau de budgets.
  const byId = new Map(departments.map((d) => [d.id, d]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(" › ");
  };

  const subject: GrantSubject = { id: viewer.id, role: viewer.role, secondaryRole: viewer.secondaryRole ?? null };

  return departments
    .map((d) => {
      const own = ownById.get(d.id);
      const grant = mergeGrants(generalGrant, own ? asGrant(own) : null);
      return {
        departmentId: d.id,
        departmentName: d.name,
        path: pathOf(d.id),
        companyName: d.company?.shortName ?? d.company?.name ?? null,
        members: d.members.length,
        operating: amountOf(d.id, "OPERATING"),
        hr: amountOf(d.id, "HR"),
        activity: amountOf(d.id, "ACTIVITY"),
        hrConsumed: consumedByDept.get(d.id) ?? 0,
        operatingConsumed: spentOf(d.id, "OPERATING"),
        activityConsumed: spentOf(d.id, "ACTIVITY"),
        editable: editableKindsOn(subject, rights, grant, d.id),
        grant: own ? asGrant(own) : EMPTY_GRANT,
        hasOwnRule: Boolean(own),
        _visible: canViewDepartmentBudget(subject, rights, grant, canViewBudgetsModule, d.id),
      };
    })
    // On ne montre pas une ligne qu'on n'a pas le droit de voir : filtrer ICI plutôt qu'à
    // l'affichage, pour que le montant ne transite même pas jusqu'au navigateur.
    .filter((r) => r._visible)
    .sort((a, b) => a.path.localeCompare(b.path, "fr"))
    .map(({ _visible, ...row }) => row);
}

/** La règle GÉNÉRALE (tous départements), pour l'écran de réglage. */
export async function getGeneralBudgetAccess(): Promise<DeptBudgetGrant> {
  const r = await prisma.departmentBudgetAccess.findFirst({ where: { departmentId: null } });
  if (!r) return EMPTY_GRANT;
  return {
    accessRoles: r.accessRoles, accessUserIds: r.accessUserIds,
    operatingRoles: r.operatingRoles, operatingUserIds: r.operatingUserIds,
    hrRoles: r.hrRoles, hrUserIds: r.hrUserIds,
    activityRoles: r.activityRoles, activityUserIds: r.activityUserIds,
  };
}

/**
 * Quelqu'un a-t-il une autorisation quelconque sur les budgets départementaux ?
 *
 * Sert à ouvrir la PORTE de l'écran : sans cela, une personne à qui le Super Admin a ouvert un
 * département mais qui n'a pas le module Budgets serait refoulée à l'entrée, et l'autorisation
 * ne servirait à rien.
 */
export async function hasAnyDepartmentBudgetGrant(user: GrantSubject): Promise<boolean> {
  const roles = [user.role, user.secondaryRole].filter((r): r is string => Boolean(r));
  const count = await prisma.departmentBudgetAccess.count({
    where: {
      OR: [
        { accessUserIds: { has: user.id } }, { operatingUserIds: { has: user.id } }, { hrUserIds: { has: user.id } },
        { activityUserIds: { has: user.id } },
        { accessRoles: { hasSome: roles } }, { operatingRoles: { hasSome: roles } }, { hrRoles: { hasSome: roles } },
        { activityRoles: { hasSome: roles } },
      ],
    },
  });
  return count > 0;
}


/** Une demande de dotation / rallonge, telle qu'elle se lit à l'écran. */
export interface DeptBudgetRequestRow {
  id: string;
  departmentId: string;
  departmentName: string;
  year: number;
  kind: DeptBudgetKind;
  amount: number;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  requester: string;
  createdAt: string;
  decisionNote: string | null;
  /** Son demandeur peut la retirer tant qu'elle n'est pas tranchée (décision du 04/10). */
  canCancel: boolean;
}

/**
 * Les demandes de dotation / rallonge d'un exercice.
 *
 * On ne renvoie QUE les départements que le spectateur a le droit de voir : une demande porte
 * un montant, et un montant sur un département fermé n'a pas à transiter jusqu'au navigateur.
 */
export async function getDepartmentBudgetRequests(
  viewer: GrantSubject,
  rights: BudgetSetter,
  canViewBudgetsModule: boolean,
  year: number,
): Promise<DeptBudgetRequestRow[]> {
  const rows = await prisma.departmentBudgetRequest.findMany({
    where: { year },
    include: { department: { select: { id: true, name: true } }, requestedBy: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  if (rows.length === 0) return [];

  const deptIds = [...new Set(rows.map((r) => r.departmentId))];
  const accessRows = await prisma.departmentBudgetAccess.findMany({
    where: { OR: [{ departmentId: { in: deptIds } }, { departmentId: null }] },
  });
  const asGrant = (r: (typeof accessRows)[number]): DeptBudgetGrant => ({
    accessRoles: r.accessRoles, accessUserIds: r.accessUserIds,
    operatingRoles: r.operatingRoles, operatingUserIds: r.operatingUserIds,
    hrRoles: r.hrRoles, hrUserIds: r.hrUserIds,
    activityRoles: r.activityRoles, activityUserIds: r.activityUserIds,
  });
  const general = accessRows.find((r) => r.departmentId === null);
  const generalGrant = general ? asGrant(general) : null;
  const ownById = new Map(accessRows.filter((r) => r.departmentId).map((r) => [r.departmentId!, r]));

  return rows
    .filter((r) => {
      const own = ownById.get(r.departmentId);
      const grant = mergeGrants(generalGrant, own ? asGrant(own) : null);
      return canViewDepartmentBudget(viewer, rights, grant, canViewBudgetsModule, r.departmentId);
    })
    .map((r) => ({
      id: r.id,
      departmentId: r.departmentId,
      departmentName: r.department.name,
      year: r.year,
      kind: r.kind as DeptBudgetKind,
      amount: toNumber(r.amount),
      reason: r.reason,
      status: r.status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED",
      requester: r.requestedBy?.name ?? "",
      createdAt: r.createdAt.toISOString(),
      decisionNote: r.decisionNote,
      canCancel: r.requestedById === viewer.id && refusAnnulationRallonge(r.status) === null,
    }));
}

/** Les départements que cette personne DIRIGE (responsable ou adjoint), via sa fiche employé. */
export async function headedDepartmentIds(userId: string): Promise<string[]> {
  const emp = await prisma.employee.findUnique({ where: { userId }, select: { id: true } });
  if (!emp) return [];
  const depts = await prisma.department.findMany({
    where: { OR: [{ headId: emp.id }, { deputyId: emp.id }] },
    select: { id: true },
  });
  return depts.map((d) => d.id);
}
