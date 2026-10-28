import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  getDepartmentBudgets, getGeneralBudgetAccess, hasAnyDepartmentBudgetGrant,
  getDepartmentBudgetRequests, headedDepartmentIds,
} from "@/lib/queries/department-budget";
import { normalizeYear, totals, canManageDepartmentBudgetAccess, canDecideDepartmentBudgetRequest } from "@/lib/department-budget";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_TABS } from "@/lib/labels";
import { DepartmentBudgetTable } from "./department-budget-table";

export const dynamic = "force-dynamic";

/**
 * BUDGET PAR DÉPARTEMENT — un tableau, deux responsables, des accès réglables.
 *
 * Le même écran porte les deux colonnes, mais chacune n'est modifiable que par qui de droit :
 * l'administrateur règle le fonctionnement, les ressources humaines règlent les employés. Les
 * mettre côte à côte est délibéré — c'est la seule façon de voir ce que coûte réellement un
 * département ; les rendre modifiables séparément l'est tout autant.
 *
 * Au-dessus de ce socle, le **Super Admin** ouvre nommément : « le responsable du Commercial
 * règle le fonctionnement DE SON département ». C'est la porte d'entrée de l'écran, et non
 * `requireModule("BUDGETS")` — sinon une personne autorisée sur un département mais sans le
 * module serait refoulée à l'entrée, et son autorisation ne servirait à rien.
 */
export default async function DepartmentBudgetsPage(props: { searchParams: Promise<{ year?: string; demande?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const year = normalizeYear(searchParams.year);

  const canViewBudgetsModule = userCan(user, "BUDGETS", "VIEW");
  const subject = { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null };
  if (!canViewBudgetsModule && !(await hasAnyDepartmentBudgetGrant(subject))) notFound();

  // Le DIRECTEUR d'un département tient ses moyens généraux et son budget métier : cette
  // qualité ne se lit pas dans un rôle (chaque directeur en a un différent) mais dans
  // l'organigramme.
  const headed = await headedDepartmentIds(user.id);
  const rights = {
    role: user.role,
    secondaryRole: user.secondaryRole ?? null,
    canManageBudgets: userCan(user, "BUDGETS", "UPDATE") || userCan(user, "BUDGETS", "VALIDATE"),
    canManageHr: userCan(user, "RH", "UPDATE"),
    headOfDepartmentIds: headed,
  };
  const canManageAccess = canManageDepartmentBudgetAccess(rights);
  const canDecide = canDecideDepartmentBudgetRequest(rights);

  const [rows, requests, tabs, generalGrant, users] = await Promise.all([
    getDepartmentBudgets(subject, rights, canViewBudgetsModule, year),
    getDepartmentBudgetRequests(subject, rights, canViewBudgetsModule, year),
    visibleTabs(user, BUDGET_TABS),
    canManageAccess ? getGeneralBudgetAccess() : Promise.resolve(null),
    // La liste des comptes ne part au navigateur QUE pour qui règle les accès.
    canManageAccess
      ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  return (
    <div className="space-y-5">
      <ModuleTabs tabs={tabs} />
      <PageHeader
        title="Budget par département"
        description="Chaque département a trois budgets : les MOYENS GÉNÉRAUX, tenus par son directeur ; la MASSE SALARIALE, réservée aux ressources humaines ; et le BUDGET MÉTIER de son activité (Ad & Pro au marketing, paiement des BV au Regulatory…). Personne ne s'accorde son propre budget : on demande une dotation ou une rallonge, l'administration tranche."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Aucun département"
          description="Créez d'abord les départements depuis Ressources humaines › Départements — un budget se rattache à un département existant."
        />
      ) : (
        <DepartmentBudgetTable
          rows={rows}
          year={year}
          totals={totals(rows)}
          requests={requests}
          canDecide={canDecide}
          canManageAccess={canManageAccess}
          generalGrant={generalGrant}
          users={users}
          demandeAOuvrir={searchParams.demande ?? null}
        />
      )}
    </div>
  );
}
